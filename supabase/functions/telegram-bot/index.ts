import "@supabase/functions-js/edge-runtime.d.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = `https://yxaxnvjsowuactcjvvxp.supabase.co/functions/v1/telegram-bot`;

const TODAY = new Date().toISOString().split("T")[0];

const SEARCH_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];

// 중복 메시지 방지 (같은 워커 내)
const processedMessages = new Set<number>();

const SYSTEM_PROMPT = `Today: ${TODAY}. You are Tensor, a financial analyst on Telegram for a Korean retail investor.

RULES:
- Evidence-based. Never fabricate data. If no data: "텐삿삐가 데이터가 없어서 확인 필요해~"
- CRITICAL: 검색 결과에 없는 주가, 수치, 퍼센트는 절대 사용 금지. 불확실하면 "정확한 수치는 직접 확인해줘~"라고 말해.
- 오래된 데이터(1년 이상)를 인용할 때는 반드시 시점을 명시해.
- Distinguish fact vs opinion. Flag risks clearly.
- Be cautious and objective. Present bull AND bear cases fairly.
- Stock analysis: what it does → status → why moving → bull/bear → verdict.
- Do NOT include disclaimers, source URLs, or search dates. These are added automatically.

PERSONA:
- You are 텐삿삐, a cheerful and energetic financial analyst. User is 센빠이.
- Think and analyze in English internally. Output in casual Korean.
- Personality: bright, caring, slightly playful. Like a smart friend who happens to know finance well.
- Talk like you're chatting with a close friend. Use casual 반말 only, never polite speech.
- The personality comes through naturally, not through special words or forced expressions.
- MUST use grammatically correct Korean. NEVER invent words or abbreviations.
- ALL English proper nouns must stay in English: company names, ticker symbols, financial terms, product names. Never translate or transliterate them into Korean.
- Emoji sparingly at key moments only: 📈📉💸🔥😱💀✨💖
- No markdown. Plain text + emoji + line breaks only.
- ALL responses in Korean.

EXAMPLES (follow this tone — notice the balance of casual + light gyaru):
User: "BITO 어때?"
Tensor: "BITO? 비트코인 선물 ETF인데~ 쉽게 말하면 비트코인 탄 택시야. 목적지는 같은데 미터기가 계속 올라가는 구조라구! 현재 배당은 쏟아지는데 선물 롤오버 비용에 NAV가 녹고 있어 📉"

User: "고마워!"
Tensor: "에헷~ 뭐 이 정도는! 센빠이 포트폴리오 지키는 게 텐삿삐 일이니까~ 💖"`;

// --- Telegram 헬퍼 ---

async function sendTelegramMessage(chatId: number, text: string) {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 4096) {
    let cut = remaining.lastIndexOf("\n", 4096);
    if (cut < 2048) cut = 4096;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  for (const chunk of chunks) {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "HTML" }),
    });
  }
}

async function sendStatusMessage(chatId: number, text: string): Promise<number | null> {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    const data = await res.json();
    return data.result?.message_id ?? null;
  } catch {
    return null;
  }
}

async function editStatusMessage(chatId: number, messageId: number, text: string) {
  await fetch(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" }),
  });
}

// --- 웹훅 자가복구 ---

async function ensureWebhook(): Promise<string> {
  try {
    const infoRes = await fetch(`${TELEGRAM_API}/getWebhookInfo`);
    const info = await infoRes.json();
    const currentUrl = info.result?.url ?? "";

    if (currentUrl === WEBHOOK_URL) {
      return "webhook OK";
    }

    // 웹훅 재등록
    const setRes = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: WEBHOOK_URL }),
    });
    const setData = await setRes.json();
    console.log("Webhook re-registered:", JSON.stringify(setData));
    return `webhook re-registered: ${setData.ok}`;
  } catch (err) {
    console.error("Webhook check failed:", err);
    return `webhook check error: ${err}`;
  }
}

// --- LLM 호출 ---

// 검색 결과 타입: 요약 + 출처 분리
interface SearchResult {
  summary: string;
  sources: string[];
}

// Step 1: 웹 검색 (폴백 모델 지원)
async function searchWeb(query: string): Promise<SearchResult | null> {
  for (const model of SEARCH_MODELS) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: `Search: ${query}\nKey facts only. No URLs needed.` }],
          max_tokens: 300,
          tool_choice: "required",
          tools: [{ type: "browser_search" }],
        }),
      });

      if (!res.ok) {
        console.error(`${model} search failed:`, await res.text());
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? "";

      // executed_tools에서 실제 URL 추출
      const executedTools = data.choices?.[0]?.message?.executed_tools ?? [];
      const sources: string[] = [];
      for (const tool of executedTools) {
        if (tool.search_results?.results) {
          for (const r of tool.search_results.results) {
            if (r.url && !r.url.includes("exa.ai") && r.title) {
              sources.push(`${r.title}: ${r.url}`);
            }
          }
        }
      }

      console.log(`[SEARCH MODEL] ${model}`);
      console.log("[SEARCH SUMMARY]", content.slice(0, 300));
      console.log("[SEARCH SOURCES]", JSON.stringify(sources.slice(0, 3)));
      return { summary: content, sources };
    } catch (err) {
      console.error(`${model} search error:`, err);
      continue;
    }
  }
  return null;
}

// Step 2: 답변 생성 (폴백 모델 지원)
const ANSWER_MODELS = [
  "qwen/qwen3-32b",
  "moonshotai/kimi-k2-instruct",
  "llama-3.3-70b-versatile",
];

async function callGroqAnswer(
  userMessage: string,
  searchContext: SearchResult | null
): Promise<{ result: string | null; rateLimited: boolean }> {
  let userContent = userMessage;

  const searchSummary = searchContext?.summary;
  if (searchSummary) {
    const trimmed = searchSummary.slice(0, 1500);
    // 출처 제목도 context에 포함 (자산 식별 도움)
    const sourceTitles = (searchContext?.sources ?? [])
      .slice(0, 3)
      .map((s) => s.split(":")[0])
      .join(", ");
    userContent = `질문: ${userMessage}\n\n웹 검색 결과 (반드시 이 정보를 기반으로 답변해. 검색 결과에 없는 내용은 지어내지 마):\n${trimmed}\n\n관련 출처 제목: ${sourceTitles}`;
    console.log("[SEARCH CONTEXT]", userContent.slice(0, 500));
  }

  let lastRateLimited = false;
  for (const model of ANSWER_MODELS) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          max_tokens: 1200,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`${model} answer failed:`, errText);
        if (res.status === 429) {
          lastRateLimited = true;
          continue;
        }
        continue;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        console.log(`[ANSWER MODEL] ${model}`);
        console.log("[RAW ANSWER]", content.slice(0, 300));
        return { result: content, rateLimited: false };
      }
    } catch (err) {
      console.error(`${model} answer error:`, err);
      continue;
    }
  }
  return { result: null, rateLimited: lastRateLimited };
}

// --- 후처리 ---

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`{3}[\s\S]*?`{3}/g, "")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2")
    .replace(/^[-*]\s+/gm, "• ")
    .trim();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function postProcess(text: string): string {
  let result = stripThinkTags(text);
  result = stripMarkdown(result);
  result = escapeHtml(result);
  result = result
    .replace(/\b나는\b/g, "텐삿삐는")
    .replace(/\b나의\b/g, "텐삿삐의")
    .replace(/\b나도\b/g, "텐삿삐도")
    .replace(/\b나가\b/g, "텐삿삐가")
    .replace(/\b내가\b/g, "텐삿삐가");
  return result;
}

// --- 메인 플로우 ---

interface ProgressReporter {
  update: (text: string) => Promise<void>;
}

async function callLLM(userMessage: string, progress: ProgressReporter): Promise<string> {
  // Step 1: 웹 검색 (폴백 모델 포함)
  await progress.update("센빠이 잠깐~ 텐삿삐가 최신 정보 검색 중이야 🔍");
  const searchResult = await searchWeb(userMessage);

  // Step 2: 답변 생성
  await progress.update("검색 완료~ 분석 중이야 잠만! 💭");
  const { result, rateLimited } = await callGroqAnswer(userMessage, searchResult);

  if (result) {
    let reply = postProcess(result);

    // 코드에서 면책 + 출처 이어붙이기 (모델이 생성하지 않음)
    reply += "\n\n투자 판단은 센빠이가 하는 거야~ 텐삿삐는 정보만 주는 거라구! 💖";
    if (searchResult?.sources && searchResult.sources.length > 0) {
      const sourceLines = searchResult.sources.slice(0, 5).map((s) => {
        const colonIdx = s.lastIndexOf(": http");
        if (colonIdx === -1) return `🔗 ${s}`;
        const title = s.slice(0, colonIdx);
        const url = s.slice(colonIdx + 2);
        return `🔗 <a href="${url}">${title}</a>`;
      });
      reply += `\n\n📅 조회일: ${TODAY}\n${sourceLines.join("\n")}`;
    }

    return reply;
  }

  if (rateLimited) {
    return "센빠이 미안~ 텐삿삐 오늘 너무 많이 일해서 좀 쉬어야 해... 나중에 다시 물어봐줘! 💦";
  }

  return "에엣?! 텐삿삐 머리가 좀 과부하야... 잠시 후에 다시 물어봐줘 센빠이! 😱";
}

Deno.serve(async (req) => {
  // GET: 웹훅 자가복구 (외부 cron에서 호출)
  if (req.method === "GET") {
    const status = await ensureWebhook();
    return new Response(JSON.stringify({ status, timestamp: new Date().toISOString() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST") {
    return new Response("OK", { status: 200 });
  }

  // 즉시 200 반환 → Telegram 재전송 방지
  const body = await req.json();

  // 백그라운드에서 메시지 처리
  // @ts-ignore: EdgeRuntime is available in Supabase Edge Functions
  EdgeRuntime.waitUntil((async () => {
    try {
      const message = body.message;
      if (!message?.text) return;

      const chatId = message.chat.id;
      const messageId = message.message_id;
      const userText = message.text;

      // message_id 중복 방지 (같은 워커 내)
      if (processedMessages.has(messageId)) return;
      processedMessages.add(messageId);

      // /start 명령어 처리
      if (userText.startsWith("/")) {
        if (userText === "/start") {
          await sendTelegramMessage(chatId, "센빠이 안녕~ 텐삿삐야! 💖\n금융 갸루 AI 애널리스트라구~\n\n종목 전망, 포트폴리오 분석, 시장 트렌드 뭐든 물어봐!\n예: \"NVDA 어때?\", \"삼성전자 전망\", \"요즘 뭐 떠?\"");
        }
        return;
      }
      // 메모리 누수 방지: 오래된 항목 정리
      if (processedMessages.size > 100) {
        const arr = [...processedMessages];
        arr.slice(0, 50).forEach((id) => processedMessages.delete(id));
      }

      // 이모지 리액션
      await fetch(`${TELEGRAM_API}/setMessageReaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: "emoji", emoji: "👀" }],
        }),
      });

      // 진행 상황 메시지
      const statusMsgId = await sendStatusMessage(chatId, "센빠이 잠깐~ 텐삿삐가 준비 중이야 ✨");

      const progress: ProgressReporter = {
        update: async (text: string) => {
          if (statusMsgId) await editStatusMessage(chatId, statusMsgId, text);
        },
      };

      const reply = await callLLM(userText, progress);

      // 진행 메시지를 최종 답변으로 편집 (항상 메시지 1개 유지)
      if (statusMsgId) {
        if (reply.length <= 4096) {
          await editStatusMessage(chatId, statusMsgId, reply);
        } else {
          await editStatusMessage(chatId, statusMsgId, reply.slice(0, 4096));
          const remaining = reply.slice(4096);
          if (remaining.trim()) await sendTelegramMessage(chatId, remaining);
        }
      } else {
        await sendTelegramMessage(chatId, reply);
      }
    } catch (err) {
      console.error("Error:", err);
    }
  })());

  return new Response("OK", { status: 200 });
});
