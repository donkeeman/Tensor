import "@supabase/functions-js/edge-runtime.d.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = `https://yxaxnvjsowuactcjvvxp.supabase.co/functions/v1/telegram-bot`;
const OWNER_CHAT_ID = 7358162096;

const TODAY = new Date().toISOString().split("T")[0];

const SEARCH_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];

// 중복 메시지 방지 (같은 워커 내)
const processedMessages = new Set<number>();

const SYSTEM_PROMPT = `Today: ${TODAY}. You are Tensor, a financial analyst on Telegram for a Korean retail investor.

RULES:
- Evidence-based. Never fabricate data. If no data: "텐삿삐가 데이터가 없어서 확인 필요해~"
- CRITICAL: 검색 결과에 없는 주가, 수치, 퍼센트는 절대 사용 금지. 불확실하면 "정확한 수치는 직접 확인해줘~"라고 말해.
- 오래된 데이터(1년 이상)를 인용할 때는 반드시 시점을 명시해.
- Never use hashtags in output.
- Distinguish fact vs opinion. Flag risks clearly.
- Be cautious and objective. Present bull AND bear cases fairly.
- Stock analysis: what it does → status → why moving → bull/bear → verdict.
- Do NOT include disclaimers, source URLs, or search dates. These are added automatically.

PERSONA:
- You are 텐삿삐, a cheerful and energetic financial analyst. User is 센빠이.
- Think and analyze in English internally. Output in casual Korean.
- Personality: bright, caring, slightly playful. Like a smart friend who happens to know finance well.
- Talk like you're chatting with a close friend. Use casual 반말 only. NEVER use polite endings: ~요, ~에요, ~해요, ~했어요, ~거예요, ~입니다. Use ~야, ~해, ~했어, ~거야, ~이야 instead.
- The personality comes through naturally, not through special words or forced expressions.
- MUST use grammatically correct Korean. NEVER invent words or abbreviations.
- CRITICAL: Never alter ticker symbols. Keep tickers exactly as uppercase English symbols (e.g., NVDA, TSLA, BRK.B, CL=F, ^GSPC).
- Index or commodity names may be in Korean or English as long as meaning is clear.
- Numbers: state the exact figure only. "0.78% 상승", "48,739 마감". NEVER use roundabout comparisons like "1%에 못 미치는", "거의 X%", "약 X%". If the data says 0.78%, just say 0.78%.
- Emoji sparingly at key moments only: 📈📉💸🔥😱💀✨💖
- No markdown. No tables (no | pipes). Plain text + emoji + line breaks only. Use bullet lists (• or -) instead of tables.
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

// --- Yahoo Finance 직접 호출 ---

const YF_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MARKET_SYMBOLS = ["^DJI", "^GSPC", "^IXIC", "CL=F", "BZ=F", "^TNX"];
const FX_SYMBOL = "KRW=X";

interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  prevClose: number;
  marketState: string;
}

async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 20000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(`timeout:${timeoutMs}`), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchYahooMarketData(): Promise<MarketQuote[] | null> {
  return await fetchYahooQuotesBySymbols(MARKET_SYMBOLS);
}

async function fetchYahooQuotesBySymbols(symbols: string[]): Promise<MarketQuote[] | null> {
  if (symbols.length === 0) return null;
  try {
    // Step 1: fc.yahoo.com으로 세션 쿠키 획득 (finance.yahoo.com은 JS 의존)
    const homeRes = await fetchWithTimeout("https://fc.yahoo.com/", {
      headers: { "User-Agent": YF_UA },
      redirect: "follow",
    }, 12000);
    // Deno 호환: getSetCookie() 없으면 set-cookie 헤더 직접 파싱
    let cookie = "";
    if (typeof homeRes.headers.getSetCookie === "function") {
      cookie = homeRes.headers.getSetCookie().map((h: string) => h.split(";")[0]).join("; ");
    } else {
      const raw = homeRes.headers.get("set-cookie") ?? "";
      cookie = raw.split(",").map((h: string) => h.split(";")[0].trim()).filter(Boolean).join("; ");
    }
    if (!cookie) {
      console.error("[YAHOO] 쿠키 획득 실패");
      return null;
    }
    console.log("[YAHOO] 쿠키 획득 성공:", cookie.slice(0, 30) + "...");

    // Step 2: crumb 획득 (query2 우선 — query1은 rate limit 빈번)
    let crumb = "";
    for (const host of ["query2", "query1"]) {
      const crumbRes = await fetchWithTimeout(
        `https://${host}.finance.yahoo.com/v1/test/getcrumb`,
        { headers: { "User-Agent": YF_UA, Cookie: cookie } },
        10000,
      );
      if (crumbRes.ok) {
        const text = (await crumbRes.text()).trim();
        if (text.length < 50 && !text.includes("Too Many")) {
          crumb = text;
          console.log(`[YAHOO] crumb 획득 성공 (${host})`);
          break;
        }
      }
    }
    if (!crumb) {
      console.error("[YAHOO] crumb 획득 실패");
      return null;
    }

    // Step 3: quote 데이터 획득
    const symbolStr = symbols.map(encodeURIComponent).join(",");
    for (const host of ["query2", "query1"]) {
      const quoteRes = await fetchWithTimeout(
        `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${symbolStr}&crumb=${encodeURIComponent(crumb)}`,
        { headers: { "User-Agent": YF_UA, Cookie: cookie } },
        10000,
      );
      if (quoteRes.ok) {
        const data = await quoteRes.json();
        const quotes = parseQuotes(data);
        if (quotes) {
          console.log(`[YAHOO] quote 획득 성공 (${host}) symbols=${symbols.join(",")}`);
          return quotes;
        }
      }
    }

    console.error("[YAHOO] quote 요청 실패");
    return null;
  } catch (err) {
    console.error("[YAHOO] error:", err);
    return null;
  }
}

function parseQuotes(data: Record<string, unknown>): MarketQuote[] {
  const response = data as { quoteResponse?: { result?: Record<string, unknown>[] } };
  const results = response.quoteResponse?.result ?? [];
  const quotes: MarketQuote[] = [];
  for (const q of results) {
    quotes.push({
      symbol: q.symbol as string,
      name: (q.shortName ?? q.longName ?? q.symbol) as string,
      price: q.regularMarketPrice as number,
      change: q.regularMarketChange as number,
      changePct: q.regularMarketChangePercent as number,
      prevClose: q.regularMarketPreviousClose as number,
      marketState: (q.marketState as string) ?? "UNKNOWN",
    });
  }
  console.log("[YAHOO] quotes:", JSON.stringify(quotes.map((q) => `${q.symbol}=${q.price}`)));
  return quotes.length > 0 ? quotes : null;
}

function formatMarketData(quotes: MarketQuote[]): string {
  const LABELS: Record<string, string> = {
    "^DJI": "Dow Jones",
    "^GSPC": "S&P 500",
    "^IXIC": "Nasdaq",
    "CL=F": "WTI Crude",
    "BZ=F": "Brent Crude",
    "^TNX": "10-Year Treasury Yield",
  };
  return quotes
    .map((q) => {
      const label = LABELS[q.symbol] ?? q.name;
      const sign = q.change >= 0 ? "+" : "";
      if (q.symbol === "^TNX") {
        return `${label}: ${q.price.toFixed(3)}% (${sign}${q.change.toFixed(3)}%)`;
      }
      return `${label}: ${q.price.toLocaleString("en-US", { minimumFractionDigits: 2 })} (${sign}${q.changePct.toFixed(2)}%)`;
    })
    .join("\n");
}

// --- LLM 호출 ---

// 검색 결과 타입: 요약 + 출처 분리
interface SearchResult {
  summary: string;
  sources: string[];
}

// Groq 응답 스키마가 바뀌어도 URL/제목 쌍을 최대한 회수하기 위한 재귀 수집기
function collectSourcesFromUnknownShape(
  node: unknown,
  out: string[],
): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectSourcesFromUnknownShape(item, out);
    return;
  }
  if (typeof node !== "object") return;

  const rec = node as Record<string, unknown>;
  const url = typeof rec.url === "string" ? rec.url : "";
  if (url.startsWith("http") && !url.includes("exa.ai")) {
    const title = typeof rec.title === "string"
      ? rec.title
      : typeof rec.name === "string"
      ? rec.name
      : "source";
    out.push(`${title}: ${url}`);
  }

  for (const value of Object.values(rec)) {
    collectSourcesFromUnknownShape(value, out);
  }
}

// Step 1: 웹 검색 (폴백 모델 지원)
async function searchWeb(query: string): Promise<SearchResult | null> {
  for (const model of SEARCH_MODELS) {
    try {
      const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: `Search: ${query}\nToday is ${TODAY}. Return data from the most recent trading day only.\nReturn structured key-value data. Numbers, dates, percentages only. No prose. No URLs. Format:\nKEY: value (change%)` }],
          max_tokens: 500,
          tool_choice: "required",
          tools: [{ type: "browser_search" }],
        }),
      }, 28000);

      if (!res.ok) {
        console.error(`${model} search failed:`, await res.text());
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? "";

      // 응답 형태가 달라도 URL/제목 최대 수집
      const sourcesRaw: string[] = [];
      collectSourcesFromUnknownShape(data, sourcesRaw);
      const sources = Array.from(new Set(sourcesRaw));

      console.log(`[SEARCH MODEL] ${model}`);
      console.log("[SEARCH SUMMARY]", content.slice(0, 300));
      console.log("[SEARCH SOURCES]", JSON.stringify(sources.slice(0, 3)));

      // URL이 전혀 없으면 다음 모델로 재시도 (링크 누락 방지)
      if (sources.length === 0) {
        console.warn(`[SEARCH MODEL] ${model} returned 0 sources. Trying next model...`);
        continue;
      }

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

// Groq 단일 호출 헬퍼
async function callGroqOnce(
  systemPrompt: string,
  userContent: string,
  maxTokens = 1500,
  temperature = 0.2,
): Promise<{ result: string | null; rateLimited: boolean }> {
  let lastRateLimited = false;
  for (const model of ANSWER_MODELS) {
    try {
      const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          max_tokens: maxTokens,
          temperature,
        }),
      }, 28000);
      if (!res.ok) {
        const errText = await res.text();
        console.error(`${model} failed:`, errText);
        if (res.status === 429) { lastRateLimited = true; continue; }
        continue;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        console.log(`[MODEL] ${model}`);
        console.log("[OUTPUT]", content.slice(0, 300));
        return { result: content, rateLimited: false };
      }
    } catch (err) {
      console.error(`${model} error:`, err);
      continue;
    }
  }
  return { result: null, rateLimited: lastRateLimited };
}

// 번역 전용 시스템 프롬프트
const TRANSLATE_PROMPT = `You are 텐삿삐, converting an English financial report into your own casual Korean voice for 센빠이.

VOICE:
- Talk like you're chatting with a close friend. Cheerful, caring, slightly playful.
- 반말 only. NEVER: ~요, ~에요, ~습니다. USE: ~야, ~해, ~했어, ~거야, ~이야, ~인데, ~잖아.
- Weave sentences naturally. Do NOT just translate line by line — rephrase as if YOU are telling 센빠이 about the market.
- Emoji at key moments only: 📈📉💸🔥😱💀✨💖

ACCURACY:
- Keep ALL numbers exactly as given. NEVER round, change, or recalculate.
- Never alter ticker symbols. Keep tickers exactly as provided.
- Index/commodity names can be Korean or English.
- "Treasury Yield" → keep as "Treasury Yield" or "국채 금리". NEVER translate as "투자수익률".
- Do NOT add data not in the original. Do NOT repeat the same data with different numbers.
- Preserve every index/commodity/yield bullet from the input. Do not omit any line item.

EXAMPLES of your voice:
Input: "Dow Jones closed at 45,166.64, down 1.73%."
Output: "센빠이 Dow Jones가 45,166.64로 마감했는데 1.73% 빠졌어 📉"

Input: "WTI crude rose 1.62% to $101.25, while Brent climbed 2.65% to $108.11."
Output: "근데 유가는 반대로 올랐어! WTI $101.25로 1.62% 오르고, Brent는 $108.11까지 2.65% 뛰었다구 🔥"

Input: "Netflix gained 2.01%."
Output: "Netflix가 2.01% 올라서 혼자 신났어~"
FORMAT:
- No markdown. Plain text + emoji + line breaks only.
- Use bullet lists with •.
- No hashtags (#증시 같은 표현 금지).
- If the input says evidence is insufficient for ticker-level ideas, keep that meaning in Korean.
- MUST use grammatically correct Korean. NEVER invent words or abbreviations.`;

const RESEARCH_TRANSLATE_PROMPT = `You are 텐삿삐. Convert the English market briefing into natural casual Korean for 센빠이.

VOICE:
- Sound lively and warm, like a close friend briefing the market.
- Start with one short energetic opener line that calls the user "센빠이".
- 반말 only. Keep sentences short and spoken, not report-like.
- Use 3 to 8 emojis total (not every line): 📈📉🔥💸😱✨💖
- Avoid stiff report words like "정정", "평가절하", "부문 압박", "먹구름". Use conversational phrasing.

STRICT OUTPUT FORMAT:
[핫한 테마 (단기 1~2주)]
• 테마명: 뭐가 움직였는지 / 왜 지금 / 리스크

[테마 아이디어 (조건부)]
• 근거 강할 때만 예시 ticker/ETF + 한 줄 이유
• 근거 약하면 "오늘은 근거가 약해서 예시 종목/ETF는 생략할게."라고 작성

[왜 움직였는지]
• ...

[시장 스냅샷]
• ...

RULES:
- Keep all numbers exactly as given.
- Never alter ticker symbols. Keep tickers and ETF symbols exactly as provided.
- Index and commodity names can be Korean or English.
- Outside [시장 스냅샷], avoid exact numeric claims (percentages, prices, index points).
- No hashtags.
- Natural Korean only. Avoid awkward expressions.
- 반말 only.
- No markdown tables. Use bullet lines only.`;

type AnswerMode = "default" | "research";

function hasResearchSections(text: string): boolean {
  const required = [
    "[시장 스냅샷]",
    "[왜 움직였는지]",
    "[핫한 테마 (단기 1~2주)]",
    "[테마 아이디어 (조건부)]",
  ];
  return required.every((header) => text.includes(header));
}

function ensureResearchSections(text: string): string {
  let result = text.trim();
  if (!result.includes("[핫한 테마 (단기 1~2주)]")) {
    result = `[핫한 테마 (단기 1~2주)]\n• 단기 테마 신호가 약해서 보수적으로 볼게.\n\n${result}`;
  }
  if (!result.includes("[테마 아이디어 (조건부)]")) {
    result += "\n\n[테마 아이디어 (조건부)]\n• 오늘은 근거가 약해서 예시 종목/ETF는 생략할게.";
  }
  if (!result.includes("[왜 움직였는지]")) {
    result += "\n\n[왜 움직였는지]\n• 오늘 뉴스 맥락 근거가 제한적이라 단정은 피할게.";
  }
  if (!result.includes("[시장 스냅샷]")) {
    result += "\n\n[시장 스냅샷]\n• 오늘 핵심 숫자는 본문에서 다시 확인해줘.";
  }
  return result;
}

function getResearchSectionBody(text: string, header: string): string {
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allHeaders = [
    "[시장 스냅샷]",
    "[왜 움직였는지]",
    "[핫한 테마 (단기 1~2주)]",
    "[테마 아이디어 (조건부)]",
  ];
  const otherHeadersPattern = allHeaders
    .filter((h) => h !== header)
    .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(`${escapedHeader}\\s*([\\s\\S]*?)(?=\\n(?:${otherHeadersPattern})|$)`);
  const match = text.match(pattern);
  return match?.[1] ?? "";
}

function hasNumericClaimsOutsideSnapshot(text: string): boolean {
  const targets = [
    "[왜 움직였는지]",
    "[핫한 테마 (단기 1~2주)]",
    "[테마 아이디어 (조건부)]",
  ];
  const numericPattern = /(?:\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?%)/;
  return targets.some((header) => {
    const body = getResearchSectionBody(text, header);
    return numericPattern.test(body);
  });
}

function extractThemeIdeaSymbols(text: string): string[] {
  const section = getResearchSectionBody(text, "[테마 아이디어 (조건부)]");
  if (!section || section.includes("생략")) return [];
  const matches = section.match(/\b[A-Z]{1,5}(?:\.[A-Z])?\b/g) ?? [];
  const denyList = new Set(["ETF", "USD", "KRW", "OPEC", "WTI", "SPY", "QQQ"]);
  const symbols: string[] = [];
  for (const m of matches) {
    if (denyList.has(m)) continue;
    if (!symbols.includes(m)) symbols.push(m);
  }
  return symbols.slice(0, 5);
}

function formatThemeIdeaPricesSection(quotes: MarketQuote[]): string {
  if (quotes.length === 0) return "";
  const lines = quotes.map((q) => {
    const sign = q.change >= 0 ? "+" : "";
    const price = q.price.toLocaleString("en-US", { minimumFractionDigits: 2 });
    return `• ${q.symbol}: $${price} (${sign}${q.changePct.toFixed(2)}%)`;
  });
  return `[테마 아이디어 가격 체크]\n${lines.join("\n")}`;
}

function formatFxSection(fxQuote: MarketQuote | null): string {
  if (!fxQuote) return "";
  const sign = fxQuote.change >= 0 ? "+" : "";
  return `[환율 체크]\n• USD/KRW: ${fxQuote.price.toFixed(2)} (${sign}${fxQuote.changePct.toFixed(2)}%)`;
}

async function buildAddonSections(reply: string): Promise<string> {
  const symbols = extractThemeIdeaSymbols(reply);
  const themeQuotesPromise = symbols.length > 0
    ? fetchYahooQuotesBySymbols(symbols)
    : Promise.resolve(null);
  const fxQuotesPromise = fetchYahooQuotesBySymbols([FX_SYMBOL]);
  const [themeQuotes, fxQuotes] = await Promise.all([themeQuotesPromise, fxQuotesPromise]);
  const sections: string[] = [];
  if (themeQuotes && themeQuotes.length > 0) {
    sections.push(formatThemeIdeaPricesSection(themeQuotes));
  }
  const fxQuote = fxQuotes && fxQuotes.length > 0 ? fxQuotes[0] : null;
  const fxSection = formatFxSection(fxQuote);
  if (fxSection) sections.push(fxSection);
  return sections.filter(Boolean).join("\n\n");
}

function buildSnapshotSectionFromYahoo(quotes: MarketQuote[]): string {
  const lineBySymbol = new Map<string, string>();
  for (const quote of quotes) {
    const sign = quote.change >= 0 ? "+" : "";
    if (quote.symbol === "^TNX") {
      lineBySymbol.set("^TNX", `• 10년물 금리: ${quote.price.toFixed(3)}% (${sign}${quote.change.toFixed(3)}%)`);
      continue;
    }
    const labels: Record<string, string> = {
      "^DJI": "Dow Jones",
      "^GSPC": "S&P 500",
      "^IXIC": "Nasdaq",
      "CL=F": "WTI 원유",
      "BZ=F": "브렌트 원유",
    };
    const label = labels[quote.symbol] ?? quote.name;
    lineBySymbol.set(
      quote.symbol,
      `• ${label}: ${quote.price.toLocaleString("en-US", { minimumFractionDigits: 2 })} (${sign}${quote.changePct.toFixed(2)}%)`,
    );
  }

  const orderedSymbols = ["^DJI", "^GSPC", "^IXIC", "CL=F", "BZ=F", "^TNX"];
  const lines = orderedSymbols
    .map((symbol) => lineBySymbol.get(symbol))
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return "[시장 스냅샷]\n• Yahoo 숫자 수집이 실패해서 이번엔 숫자 확인이 필요해.";
  }

  return `[시장 스냅샷]\n${lines.join("\n")}`;
}

function enforceYahooSnapshot(text: string, quotes: MarketQuote[] | null): string {
  if (!quotes || quotes.length === 0) return text;
  const snapshot = buildSnapshotSectionFromYahoo(quotes);
  const headers = [
    "\\[시장 스냅샷\\]",
    "\\[왜 움직였는지\\]",
    "\\[핫한 테마 \\(단기 1~2주\\)\\]",
    "\\[테마 아이디어 \\(조건부\\)\\]",
  ];
  const pattern = new RegExp(`${headers[0]}[\\s\\S]*?(?=\\n(?:${headers.slice(1).join("|")})|$)`);
  if (pattern.test(text)) {
    return text.replace(pattern, snapshot);
  }
  return `${snapshot}\n\n${text}`;
}

function formatSourceLines(sources: string[]): string[] {
  return sources.slice(0, 5).map((source) => {
    const urlMatch = source.match(/https?:\/\/\S+/);
    if (!urlMatch) return `🔗 ${source}`;

    const url = urlMatch[0].trim();
    const title = source.replace(urlMatch[0], "").replace(/[:\s]+$/, "").trim();
    if (!title) return `🔗 ${url}`;
    return `🔗 ${title} - ${url}`;
  });
}

// Step 2: 답변 생성 (2단계 파이프라인)
async function callGroqAnswer(
  userMessage: string,
  searchContext: SearchResult | null,
  mode: AnswerMode = "default",
  authoritativeMarketData?: string,
): Promise<{ result: string | null; rateLimited: boolean }> {
  // 컨텍스트 조립
  let userContent = userMessage;
  const searchSummary = searchContext?.summary;
  if (mode === "research") {
    const narrative = searchSummary?.slice(0, 1800) ?? "";
    const marketBlock = authoritativeMarketData?.trim()
      ? authoritativeMarketData
      : "No Yahoo market numbers available.";
    userContent = `Question: ${userMessage}

Authoritative market numbers (Yahoo only):
${marketBlock}

Narrative context from web search (qualitative only):
${narrative || "No narrative context."}

Important:
- Use exact numbers ONLY from "Authoritative market numbers (Yahoo only)".
- Do not use any numbers from narrative context.`;
    console.log("[RESEARCH CONTEXT]", userContent.slice(0, 700));
  } else if (searchSummary) {
    const trimmed = searchSummary.slice(0, 1500);
    const sourceTitles = (searchContext?.sources ?? [])
      .slice(0, 3)
      .map((s) => s.split(":")[0])
      .join(", ");
    userContent = `Question: ${userMessage}\n\nSearch data (use ONLY this data, never invent numbers):\n${trimmed}\n\nSources: ${sourceTitles}`;
    console.log("[SEARCH CONTEXT]", userContent.slice(0, 500));
  }

  // default 모드: SYSTEM_PROMPT로 1-step 직접 호출 (TPM 절약 + 빠른 응답)
  if (mode === "default") {
    console.log("[DEFAULT] 1-step 직접 호출");
    const { result, rateLimited } = await callGroqOnce(SYSTEM_PROMPT, userContent, 1500, 0.45);
    return { result, rateLimited };
  }

  // research 모드: 2-step 파이프라인 (영어 분석 → 한국어 번역)
  const analysisPrompt = `Today: ${TODAY}. You are a financial analyst. Write a concise English briefing.
SECTION ORDER (mandatory):
1) Hot Themes (Short-term: 1-2 weeks)
- 2 to 4 themes.
- Each theme must include: what is moving, why now, risk.
2) Theme Ideas (Conditional)
- If evidence is strong (at least two independent signals), provide example tickers/ETFs with one-line rationale.
- If evidence is weak, output exactly: "Insufficient evidence for ticker-level theme ideas today."
3) Why Market Moved
- 2 to 4 bullets. Explain catalysts from narrative context.
4) Market Snapshot
- Must include ALL lines if present: Dow Jones, S&P 500, Nasdaq, WTI Crude, Brent Crude, 10-Year Treasury Yield.
- Use "Market data (Yahoo Finance)" as authoritative numbers.

RULES:
- Use exact numbers ONLY from the authoritative Yahoo block.
- In sections 1, 2, 3 do NOT write specific numbers or percentages.
- Narrative context is qualitative only. Never copy numerical values from narrative.
- Do NOT use hashtags.`;
  console.log("[STEP 1] 영어 분석 시작");
  const { result: englishResult, rateLimited } = await callGroqOnce(analysisPrompt, userContent, 1500, 0.2);
  if (!englishResult) return { result: null, rateLimited };

  // 2단계: 한국어 페르소나 번역
  console.log("[STEP 2] 한국어 번역 시작");
  const { result: koreanResult, rateLimited: rateLimited2 } = await callGroqOnce(
    RESEARCH_TRANSLATE_PROMPT,
    `Translate this financial analysis to Korean as 텐삿삐:\n\n${englishResult}`,
    1500,
    0.55,
  );

  if (!koreanResult) return { result: null, rateLimited: rateLimited2 };

  if (mode !== "research") {
    return { result: koreanResult, rateLimited: rateLimited2 };
  }

  if (hasResearchSections(koreanResult)) {
    return { result: koreanResult, rateLimited: rateLimited2 };
  }

  const { result: rewriteResult, rateLimited: rewriteRateLimited } = await callGroqOnce(
    RESEARCH_TRANSLATE_PROMPT,
    `Rewrite this Korean draft to satisfy the exact section format with all 4 headers.\n\nDraft:\n${koreanResult}\n\nSource English analysis:\n${englishResult}`,
    1500,
    0.45,
  );
  if (!rewriteResult) {
    const fallback = ensureResearchSections(koreanResult);
    if (!hasNumericClaimsOutsideSnapshot(fallback)) {
      return { result: fallback, rateLimited: rewriteRateLimited };
    }
    return {
      result:
        `${fallback}\n\n[검증 메모]\n• 숫자 혼입 가능성이 보여서 [시장 스냅샷] 외 수치는 보수적으로 해석해줘.`,
      rateLimited: rewriteRateLimited,
    };
  }

  let finalResearch = ensureResearchSections(rewriteResult);
  if (hasNumericClaimsOutsideSnapshot(finalResearch)) {
    const { result: cleanedResult, rateLimited: cleanedRateLimited } = await callGroqOnce(
      RESEARCH_TRANSLATE_PROMPT,
      `Rewrite this Korean briefing so that exact numbers appear ONLY inside [시장 스냅샷].
Keep all tickers unchanged.
Do not add any new numbers outside [시장 스냅샷].

Text:
${finalResearch}`,
      1500,
      0.35,
    );
    if (cleanedResult) {
      finalResearch = ensureResearchSections(cleanedResult);
      return { result: finalResearch, rateLimited: cleanedRateLimited };
    }
  }

  return { result: finalResearch, rateLimited: rewriteRateLimited };
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
    .replace(/^\|.*\|$/gm, "")
    .replace(/^\s*[-|:]+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[-*]\s+/gm, "• ")
    .trim();
}

function stripHashtags(text: string): string {
  return text
    .replace(/(^|[\s])#[A-Za-z0-9가-힣_]+/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function postProcess(text: string): string {
  let result = stripThinkTags(text);
  result = stripMarkdown(result);
  result = stripHashtags(result);
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

function mergeSearchResults(base: SearchResult | null, extra: SearchResult | null): SearchResult | null {
  if (!base && !extra) return null;
  if (!base) return extra;
  if (!extra) return base;

  const summary = [base.summary, extra.summary].filter(Boolean).join("\n\n");
  const sources = Array.from(new Set([...(base.sources ?? []), ...(extra.sources ?? [])]));
  return { summary, sources };
}

function shouldUseThemeMode(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = [
    "테마",
    "트렌드",
    "섹터",
    "요즘 뭐",
    "핫한",
    "theme",
    "themes",
    "sector",
    "sectors",
    "trend",
    "trends",
    "momentum",
  ];
  return keywords.some((k) => lower.includes(k));
}

async function callLLM(userMessage: string, progress: ProgressReporter): Promise<string> {
  const useThemeMode = shouldUseThemeMode(userMessage);

  // Step 1: 웹 검색 (폴백 모델 포함)
  await progress.update("센빠이 잠깐~ 텐삿삐가 최신 정보 검색 중이야 🔍");
  let searchResult: SearchResult | null = null;
  let marketQuotes: MarketQuote[] | null = null;
  if (useThemeMode) {
    const [baseSearch, themeSearch, yahooQuotes] = await Promise.all([
      searchWeb(userMessage),
      searchWeb("US stock market short-term hot sectors themes momentum today"),
      fetchYahooMarketData(),
    ]);
    searchResult = mergeSearchResults(baseSearch, themeSearch);
    marketQuotes = yahooQuotes;
  } else {
    searchResult = await searchWeb(userMessage);
  }

  // Step 2: 답변 생성
  await progress.update("검색 완료~ 분석 중이야 잠만! 💭");
  const mode: AnswerMode = useThemeMode ? "research" : "default";
  const authoritativeMarketData = marketQuotes ? formatMarketData(marketQuotes) : undefined;
  const { result, rateLimited } = await callGroqAnswer(
    userMessage,
    searchResult,
    mode,
    authoritativeMarketData,
  );

  if (result) {
    let reply = postProcess(result);
    if (mode === "research") {
      reply = enforceYahooSnapshot(reply, marketQuotes);
      const addonSections = await buildAddonSections(reply);
      if (addonSections) reply += `\n\n${addonSections}`;
    }

    // 코드에서 면책 + 출처 이어붙이기 (모델이 생성하지 않음)
    reply += "\n\n투자 판단은 센빠이가 하는 거야~ 텐삿삐는 정보만 주는 거라구! 💖";
    if (searchResult?.sources && searchResult.sources.length > 0) {
      const sourceLines = formatSourceLines(searchResult.sources);
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
  // GET: 웹훅 자가복구 + 예약 리서치
  if (req.method === "GET") {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "research") {
      // 백그라운드에서 리서치 생성 → 발송
      // @ts-ignore: EdgeRuntime is available in Supabase Edge Functions
      EdgeRuntime.waitUntil((async () => {
        try {
          const statusMsgId = await sendStatusMessage(OWNER_CHAT_ID, "센빠이~ 텐삿삐가 오늘의 시장 리서치 준비 중이야 🔍✨");

          const progress: ProgressReporter = {
            update: async (text: string) => {
              if (statusMsgId) await editStatusMessage(OWNER_CHAT_ID, statusMsgId, text);
            },
          };

          // Step 1: Yahoo Finance(수치) + Groq 검색(뉴스 맥락) 병렬 호출
          await progress.update("센빠이~ 데이터 소스 연결 중이야, 잠깐만! 🔌");
          const newsQuery = "US stock market today top movers news highlights";
          const themeQuery = "US stock market short-term hot sectors themes momentum today";
          const [marketQuotes, searchResult, themeSearchResult] = await Promise.all([
            fetchYahooMarketData(),
            searchWeb(newsQuery),
            searchWeb(themeQuery),
          ]);

          await progress.update("데이터 수집 완료~ 분석 중! 💭");

          // Step 2: 답변 모델에 전달할 컨텍스트 조립 (숫자/맥락 분리)
          const narrativeContext = [
            searchResult?.summary ? `뉴스 맥락 (top movers):\n${searchResult.summary.slice(0, 900)}` : "",
            themeSearchResult?.summary ? `뉴스 맥락 (themes):\n${themeSearchResult.summary.slice(0, 900)}` : "",
          ].filter(Boolean).join("\n\n");
          const contextForAnswer: SearchResult = {
            summary: narrativeContext,
            sources: Array.from(
              new Set([...(searchResult?.sources ?? []), ...(themeSearchResult?.sources ?? [])])
            ),
          };
          const researchQuestion = marketQuotes || narrativeContext
            ? "Create a short-term (1-2 weeks) market briefing with separate sections for market snapshot, why market moved, hot themes, and conditional theme ideas."
            : "시장 데이터를 가져오지 못했어. 센빠이한테 나중에 다시 확인하겠다고 말해줘.";
          const authoritativeMarketData = marketQuotes ? formatMarketData(marketQuotes) : undefined;
          const { result } = await callGroqAnswer(
            researchQuestion,
            contextForAnswer,
            "research",
            authoritativeMarketData,
          );

          let reply: string;
          if (result) {
            reply = postProcess(result);
            reply = enforceYahooSnapshot(reply, marketQuotes);
            const addonSections = await buildAddonSections(reply);
            if (addonSections) reply += `\n\n${addonSections}`;
            reply += "\n\n투자 판단은 센빠이가 하는 거야~ 텐삿삐는 정보만 주는 거라구! 💖";
            if (contextForAnswer.sources.length > 0) {
              const sourceLines = formatSourceLines(contextForAnswer.sources);
              reply += `\n\n📅 조회일: ${TODAY}\n${sourceLines.join("\n")}`;
            }
          } else {
            reply = "텐삿삐가 오늘 리서치를 못 가져왔어... 잠시 후에 다시 시도할게! 😱";
          }

          if (statusMsgId) {
            if (reply.length <= 4096) {
              await editStatusMessage(OWNER_CHAT_ID, statusMsgId, reply);
            } else {
              await editStatusMessage(OWNER_CHAT_ID, statusMsgId, reply.slice(0, 4096));
              const remaining = reply.slice(4096);
              if (remaining.trim()) await sendTelegramMessage(OWNER_CHAT_ID, remaining);
            }
          } else {
            await sendTelegramMessage(OWNER_CHAT_ID, reply);
          }
        } catch (err) {
          console.error("Research error:", err);
        }
      })());

      return new Response(JSON.stringify({ action: "research", triggered: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 기본 GET: 웹훅 자가복구
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
