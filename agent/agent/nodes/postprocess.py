from __future__ import annotations

import asyncio
import datetime
import re
from typing import Any

from agent.config import FX_SYMBOL
from agent.nodes.market import (
    build_snapshot_section_from_yahoo,
    fetch_yahoo_quotes_by_symbols,
    format_fx_section,
    format_theme_idea_prices_section,
)
from agent.nodes.translate import get_research_section_body
from agent.state import AgentState


RATE_LIMIT_FALLBACK = "센빠이 미안~ 텐삿삐 오늘 너무 많이 일해서 좀 쉬어야 해... 나중에 다시 물어봐줘! 💦"
ERROR_FALLBACK = "에엣?! 텐삿삐 머리가 좀 과부하야... 잠시 후에 다시 물어봐줘 센빠이! 😱"
DISCLAIMER_LINE = "투자 판단은 센빠이가 하는 거야~ 텐삿삐는 정보만 주는 거라구! 💖"


def strip_think_tags(text: str) -> str:
    return re.sub(r"<think>[\s\S]*?</think>\s*", "", text).strip()


def strip_markdown(text: str) -> str:
    result = text
    result = re.sub(r"^#{1,6}\s+", "", result, flags=re.MULTILINE)
    result = re.sub(r"\*\*(.+?)\*\*", r"\1", result)
    result = re.sub(r"\*(.+?)\*", r"\1", result)
    result = re.sub(r"__(.+?)__", r"\1", result)
    result = re.sub(r"_(.+?)_", r"\1", result)
    result = re.sub(r"~~(.+?)~~", r"\1", result)
    result = re.sub(r"`{3}[\s\S]*?`{3}", "", result)
    result = re.sub(r"`(.+?)`", r"\1", result)
    result = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 \2", result)
    result = re.sub(r"^\|.*\|$", "", result, flags=re.MULTILINE)
    result = re.sub(r"^\s*[-|:]+\s*$", "", result, flags=re.MULTILINE)
    result = re.sub(r"\n{3,}", "\n\n", result)
    result = re.sub(r"^[-*]\s+", "• ", result, flags=re.MULTILINE)
    return result.strip()


def strip_hashtags(text: str) -> str:
    result = re.sub(r"(^|[\s])#[A-Za-z0-9가-힣_]+", r"\1", text)
    result = re.sub(r"[ \t]{2,}", " ", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def replace_first_person(text: str) -> str:
    result = text
    result = result.replace("나는", "텐삿삐는")
    result = result.replace("나의", "텐삿삐의")
    result = result.replace("나도", "텐삿삐도")
    result = result.replace("나가", "텐삿삐가")
    result = result.replace("내가", "텐삿삐가")
    return result


def post_process(text: str) -> str:
    result = strip_think_tags(text)
    result = strip_markdown(result)
    result = strip_hashtags(result)
    result = escape_html(result)
    return replace_first_person(result)


def enforce_yahoo_snapshot(text: str, quotes: list[dict] | None) -> str:
    if not quotes:
        return text

    snapshot = build_snapshot_section_from_yahoo(quotes)
    pattern = re.compile(
        r"\[시장 스냅샷\][\s\S]*?(?=\n(?:\[왜 움직였는지\]|\[핫한 테마 \(단기 1~2주\)\]|\[테마 아이디어 \(조건부\)\])|$)"
    )
    if pattern.search(text):
        return pattern.sub(snapshot, text)
    return f"{snapshot}\n\n{text}"


def extract_theme_idea_symbols(text: str) -> list[str]:
    section = get_research_section_body(text, "[테마 아이디어 (조건부)]")
    if not section or "생략" in section:
        return []

    matches = re.findall(r"\b[A-Z]{1,5}(?:\.[A-Z])?\b", section)
    deny_list = {"ETF", "USD", "KRW", "OPEC", "WTI", "SPY", "QQQ"}
    symbols: list[str] = []
    for symbol in matches:
        if symbol in deny_list:
            continue
        if symbol not in symbols:
            symbols.append(symbol)
    return symbols[:5]


def format_source_lines(sources: list[str]) -> list[str]:
    return [f"🔗 {source}" for source in sources[:5]]


async def postprocess_node(state: AgentState) -> dict[str, Any]:
    translated = state.get("translated_result") or state.get("analysis_result")
    if not translated:
        error = str(state.get("error") or "")
        if error == "rate_limited":
            return {"final_reply": RATE_LIMIT_FALLBACK}
        return {"final_reply": ERROR_FALLBACK}

    reply = post_process(translated)
    if state.get("mode") == "research":
        reply = enforce_yahoo_snapshot(reply, state.get("market_quotes"))

        symbols = extract_theme_idea_symbols(reply)
        theme_task = fetch_yahoo_quotes_by_symbols(symbols) if symbols else asyncio.sleep(0, result=None)
        fx_task = fetch_yahoo_quotes_by_symbols([FX_SYMBOL])
        theme_quotes, fx_quotes = await asyncio.gather(theme_task, fx_task)

        addon_parts: list[str] = []
        if theme_quotes:
            addon_parts.append(format_theme_idea_prices_section(theme_quotes))

        fx_quote = fx_quotes[0] if fx_quotes else None
        fx_section = format_fx_section(fx_quote)
        if fx_section:
            addon_parts.append(fx_section)

        if addon_parts:
            reply += "\n\n" + "\n\n".join(addon_parts)

    reply += f"\n\n{DISCLAIMER_LINE}"

    all_sources: list[str] = []
    search_result = state.get("search_result")
    if isinstance(search_result, dict):
        sources = search_result.get("sources")
        if isinstance(sources, list):
            all_sources.extend(source for source in sources if isinstance(source, str) and source.strip())

    theme_search_result = state.get("theme_search_result")
    if isinstance(theme_search_result, dict):
        sources = theme_search_result.get("sources")
        if isinstance(sources, list):
            all_sources.extend(source for source in sources if isinstance(source, str) and source.strip())

    unique_sources = list(dict.fromkeys(all_sources))
    if unique_sources:
        today = datetime.date.today().isoformat()
        source_lines = format_source_lines(unique_sources)
        reply += f"\n\n📅 조회일: {today}\n" + "\n".join(source_lines)

    return {"final_reply": reply}
