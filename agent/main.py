import asyncio
import contextlib
import datetime
import os
from collections import OrderedDict
from contextlib import asynccontextmanager

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from agent.graph import graph
from agent.nodes.market import fetch_yahoo_market_data, format_market_data
from agent.state import AgentState

load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
WEBHOOK_BASE_URL = os.getenv("WEBHOOK_BASE_URL", "").strip().rstrip("/")
TELEGRAM_WEBHOOK_SECRET = os.getenv("TELEGRAM_WEBHOOK_SECRET", "").strip()
WEBHOOK_PATH = f"/tg/{TELEGRAM_WEBHOOK_SECRET}" if TELEGRAM_WEBHOOK_SECRET else "/tg/__unset__"
RESEARCH_PATH = f"/research/{TELEGRAM_WEBHOOK_SECRET}" if TELEGRAM_WEBHOOK_SECRET else "/research/__unset__"
RESEARCH_FALLBACK_QUESTION = "시장 데이터를 가져오지 못했어. 센빠이한테 나중에 다시 확인하겠다고 말해줘."


def _get_owner_chat_id() -> int:
    raw = os.getenv("OWNER_CHAT_ID", "0").strip()
    try:
        return int(raw)
    except ValueError:
        return 0


OWNER_CHAT_ID = _get_owner_chat_id()


def split_telegram_html_chunks(text: str, limit: int = 4096) -> list[str]:
    chunks: list[str] = []
    remaining = text

    while len(remaining) > limit:
        cut = remaining.rfind("\n", 0, limit)
        if cut < 2048:
            cut = limit

        candidate = remaining[:cut]
        last_amp = candidate.rfind("&")
        last_semicolon = candidate.rfind(";")
        if last_amp > last_semicolon:
            safe_cut = last_amp
            if safe_cut > 0:
                candidate = remaining[:safe_cut]
                cut = safe_cut

        chunks.append(candidate)
        remaining = remaining[cut:].lstrip("\n")

    if remaining:
        chunks.append(remaining)

    return chunks


async def send_telegram_message(chat_id: int, text: str):
    chunks = split_telegram_html_chunks(text)

    async with httpx.AsyncClient() as client:
        for chunk in chunks:
            await client.post(
                f"{TELEGRAM_API}/sendMessage",
                json={"chat_id": chat_id, "text": chunk, "parse_mode": "HTML"},
            )


async def send_status_message(chat_id: int, text: str) -> int | None:
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{TELEGRAM_API}/sendMessage",
                json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            )
            data = res.json()
            return data.get("result", {}).get("message_id")
    except Exception:
        return None


async def edit_status_message(chat_id: int, message_id: int, text: str):
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{TELEGRAM_API}/editMessageText",
            json={"chat_id": chat_id, "message_id": message_id, "text": text, "parse_mode": "HTML"},
        )


async def set_reaction(chat_id: int, message_id: int, emoji: str = "👀"):
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{TELEGRAM_API}/setMessageReaction",
                json={"chat_id": chat_id, "message_id": message_id, "reaction": [{"type": "emoji", "emoji": emoji}]},
            )
    except Exception:
        return


def log_background_exception(task: asyncio.Task):
    try:
        task.result()
    except Exception as error:
        print(f"[background] task failed: {error}")


def create_background_task(coro):
    task = asyncio.create_task(coro)
    task.add_done_callback(log_background_exception)
    return task


async def update_progress_status(chat_id: int, status_msg_id: int):
    try:
        await asyncio.sleep(1.0)
        await edit_status_message(chat_id, status_msg_id, "센빠이 잠깐~ 텐삿삐가 최신 정보 검색 중이야 🔍")
        await asyncio.sleep(2.0)
        await edit_status_message(chat_id, status_msg_id, "검색 완료~ 분석 중이야 잠만! 💭")
    except asyncio.CancelledError:
        return
    except Exception:
        return


# 한국어 주석: 삽입 순서 보장을 위해 OrderedDict를 사용
processed_messages: OrderedDict[int, None] = OrderedDict()


def mark_processed_message(message_id: int):
    processed_messages[message_id] = None
    processed_messages.move_to_end(message_id)
    if len(processed_messages) > 100:
        for _ in range(50):
            if not processed_messages:
                break
            processed_messages.popitem(last=False)


async def process_message(chat_id: int, message_id: int, user_text: str):
    await set_reaction(chat_id, message_id)
    status_msg_id = await send_status_message(chat_id, "센빠이 잠깐~ 텐삿삐가 준비 중이야 ✨")
    progress_task = None
    if status_msg_id:
        progress_task = asyncio.create_task(update_progress_status(chat_id, status_msg_id))

    initial_state: AgentState = {
        "user_message": user_text,
        "chat_id": chat_id,
        "message_id": message_id,
        "status_message_id": status_msg_id,
        "mode": "default",
        "search_result": None,
        "theme_search_result": None,
        "market_quotes": None,
        "market_data_formatted": None,
        "analysis_result": None,
        "translated_result": None,
        "retry_count": 0,
        "final_reply": None,
        "error": None,
    }

    result = None
    try:
        result = await graph.ainvoke(initial_state)
    except Exception as error:
        print(f"[process_message] graph failed: {error}")
    finally:
        if progress_task:
            progress_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await progress_task

    reply = result.get("final_reply", "에엣?! 뭔가 문제가 생겼어 센빠이... 😱") if isinstance(result, dict) else "에엣?! 뭔가 문제가 생겼어 센빠이... 😱"
    reply_chunks = split_telegram_html_chunks(reply)

    if status_msg_id:
        if len(reply_chunks) == 1:
            await edit_status_message(chat_id, status_msg_id, reply_chunks[0])
        else:
            await edit_status_message(chat_id, status_msg_id, reply_chunks[0])
            for chunk in reply_chunks[1:]:
                if chunk.strip():
                    await send_telegram_message(chat_id, chunk)
    else:
        await send_telegram_message(chat_id, reply)


async def ensure_webhook() -> str:
    if not WEBHOOK_BASE_URL or not TELEGRAM_WEBHOOK_SECRET:
        return "webhook config missing"

    target_url = f"{WEBHOOK_BASE_URL}{WEBHOOK_PATH}"

    try:
        async with httpx.AsyncClient() as client:
            info_res = await client.get(f"{TELEGRAM_API}/getWebhookInfo")
            info_data = info_res.json()
            current_url = info_data.get("result", {}).get("url", "")

            if current_url == target_url:
                return "webhook OK"

            set_res = await client.post(
                f"{TELEGRAM_API}/setWebhook",
                json={
                    "url": target_url,
                    "secret_token": TELEGRAM_WEBHOOK_SECRET,
                    "drop_pending_updates": True,
                },
            )
            set_data = set_res.json()
            return f"webhook re-registered: {set_data.get('ok')}"
    except Exception as error:
        return f"webhook check error: {error}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    status = await ensure_webhook()
    print(f"[startup] {status}")
    yield


app = FastAPI(lifespan=lifespan)


def _verify_secret_token(header_value: str | None) -> None:
    if not TELEGRAM_WEBHOOK_SECRET or header_value != TELEGRAM_WEBHOOK_SECRET:
        raise HTTPException(status_code=403, detail="forbidden")


@app.post(WEBHOOK_PATH)
async def webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
):
    _verify_secret_token(x_telegram_bot_api_secret_token)

    body = await request.json()
    message = body.get("message")
    if not message or not message.get("text"):
        return JSONResponse({"ok": True})

    chat_id = message["chat"]["id"]
    message_id = message["message_id"]
    user_text = message["text"]

    if message_id in processed_messages:
        return JSONResponse({"ok": True})
    mark_processed_message(message_id)

    if user_text.startswith("/"):
        if user_text == "/start":
            create_background_task(
                send_telegram_message(chat_id, "센빠이 안녕~ 텐삿삐야! 💖\n금융 갸루 AI 애널리스트라구~\n\n종목 전망, 포트폴리오 분석, 시장 트렌드 뭐든 물어봐!\n예: \"NVDA 어때?\", \"삼성전자 전망\", \"요즘 뭐 떠?\"")
            )
        return JSONResponse({"ok": True})

    create_background_task(process_message(chat_id, message_id, user_text))
    return JSONResponse({"ok": True})


@app.post(RESEARCH_PATH)
async def trigger_research():
    create_background_task(run_scheduled_research())
    return JSONResponse({"action": "research", "triggered": True})


@app.get("/")
async def health():
    return JSONResponse({"status": "ok", "timestamp": datetime.datetime.now().isoformat()})


async def run_scheduled_research():
    if OWNER_CHAT_ID <= 0:
        print("Research skipped: OWNER_CHAT_ID is not set.")
        return

    try:
        status_msg_id = await send_status_message(OWNER_CHAT_ID, "센빠이~ 텐삿삐가 오늘의 시장 리서치 준비 중이야 🔍✨")
        if status_msg_id:
            await edit_status_message(OWNER_CHAT_ID, status_msg_id, "센빠이~ 데이터 소스 연결 중이야, 잠깐만! 🔌")

        market_quotes = await fetch_yahoo_market_data()
        market_data_formatted = format_market_data(market_quotes) if market_quotes else None
        research_question = "오늘 시장 트렌드 브리핑 해줘" if market_quotes else RESEARCH_FALLBACK_QUESTION

        if status_msg_id:
            await edit_status_message(OWNER_CHAT_ID, status_msg_id, "데이터 수집 완료~ 분석 중! 💭")

        initial_state: AgentState = {
            "user_message": research_question,
            "chat_id": OWNER_CHAT_ID,
            "message_id": 0,
            "status_message_id": status_msg_id,
            "mode": "research",
            "search_result": None,
            "theme_search_result": None,
            "market_quotes": market_quotes,
            "market_data_formatted": market_data_formatted,
            "analysis_result": None,
            "translated_result": None,
            "retry_count": 0,
            "final_reply": None,
            "error": None,
        }

        result = await graph.ainvoke(initial_state)
        reply = result.get("final_reply", "텐삿삐가 오늘 리서치를 못 가져왔어... 잠시 후에 다시 시도할게! 😱")
        reply_chunks = split_telegram_html_chunks(reply)

        if status_msg_id:
            if len(reply_chunks) == 1:
                await edit_status_message(OWNER_CHAT_ID, status_msg_id, reply_chunks[0])
            else:
                await edit_status_message(OWNER_CHAT_ID, status_msg_id, reply_chunks[0])
                for chunk in reply_chunks[1:]:
                    if chunk.strip():
                        await send_telegram_message(OWNER_CHAT_ID, chunk)
        else:
            await send_telegram_message(OWNER_CHAT_ID, reply)
    except Exception as error:
        print(f"Research error: {error}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
