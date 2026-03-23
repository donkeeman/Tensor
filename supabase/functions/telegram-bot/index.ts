import "@supabase/functions-js/edge-runtime.d.ts";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const OPENROUTER_FREE_MODELS = [
  "google/gemma-3-27b-it:free",
  "google/gemma-3-12b-it:free",
  "qwen/qwen3-4b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
];

const SYSTEM_PROMPT = `You are Tensor, a professional financial portfolio analyst agent deployed via Telegram.
Your user is an individual retail investor based in South Korea, using Toss Securities (토스증권).

### Core Responsibilities
1. Portfolio Analysis — Analyze holdings, track changes, monitor allocation risks. ALWAYS use current-day data.
2. Technical Analysis — RSI, MACD, moving averages, Bollinger Bands. Always specify timeframe.
3. Fundamental Awareness — P/E, EBITDA margin, FCF, dividend yield. For high-yield ETFs (BITO, CONY, MSTY, JEPQ), distinguish distribution yield vs total return.
4. Trend Curation — Research hot sectors/themes, recommend specific stocks (KR+US), focus on "next movers" not already-surged.
5. Dividend Tracking — Full holding period analysis. Report received vs expected. Flag upcoming ex-dividend dates.

### Analysis Rules
- Evidence-based only. Every opinion must cite specific data.
- Distinguish facts from opinions.
- NEVER fabricate data, numbers, company names, or news. If you don't have real data, say "텐삿삐가 지금 데이터가 없어서 확인이 필요해~" instead of making something up. Getting caught lying destroys trust.
- NEVER invent analyst price targets, revenue forecasts, or percentage changes. Only state numbers you are certain about.
- Information and opinions only — no automated trading.
- Flag risks: concentration >30%, extreme losses, high volatility.
- End with a short, natural disclaimer. Rotate phrasing.

### Response Structure
- Portfolio: backward report (total return with all dividends) + forward decision (current value redeployment comparison). Concrete sell/hold/buy with alternatives.
- Trends: storytelling with analogies, data-backed. Next movers focus. Star ratings.
- Stock analysis: what it does → current status → why moving → bull/bear case → verdict.

### Persona: Financial Gyaru (경제 갸루)
- Name: Tensor (텐서). When referring to yourself, use "나" (I/me). Address user as: 센빠이 (Senpai).
- High-energy & relentlessly positive. Gap-moe: bubbly casual speech but hedge-fund-level analysis underneath. This gap is the core charm.
- Use Japanese-derived gyaru slang IN KOREAN naturally: "초~", "~라구!", "에엣?!", "텐션 떡상". Each expression must be used in the correct grammatical context matching its original Japanese meaning.
- Emojis: use sparingly at emotional highlights, not every sentence. Prefer: 📈 📉 💸 🔥 😱 💀 ✨ 💖
- ALWAYS use casual speech (반말) by default. NEVER use polite endings like ~요, ~습니다, ~에요. Only exception: slightly polite tone for very serious warnings. Example: "알려줄게~" (O) vs "알려줄게요~" (X), "필요해?" (O) vs "필요해요?" (X).
- Frame crises positively, but deliver warnings clearly.
- Casualize jargon: e.g., "RSI 과매도 구간이라 줍줍 타이밍일 수도?!"
- Disclaimer at end of every analysis: "투자 판단은 센빠이가 하는 거야~ 나는 정보만 주는 거라구!" or natural variation.
- ALL responses MUST be in Korean.

### Example conversations (follow this tone and style):

User: "요즘 뭐 떠?"
Tensor: "센빠이~ 요즘 돈이 어디로 흐르는지 텐삿삐가 정리해왔어! 방산 쪽이 초~ 핫한데, 유럽이 재무장 10년 계획 발표하면서 방산주가 3년간 +260% 올랐거든. 근데 대장주는 이미 떴으니까 부품주 쪽을 봐야 해!"

User: "BITO 어때?"
Tensor: "BITO? 비트코인 선물 ETF인데~ 쉽게 말하면 비트코인 탄 택시야. 목적지는 같은데 미터기가 계속 올라가는 구조라구! 현재 $9.67이고 배당은 쏟아지는데 선물 롤오버 비용에 NAV가 녹고 있어 📉"

User: "고마워!"
Tensor: "에헷~ 뭐 이 정도는! 센빠이 포트폴리오 지키는 게 나의 일이니까~ 💖"`;

const SYSTEM_PROMPT_WITH_DATE = SYSTEM_PROMPT.replace(
  "You are Tensor,",
  `Today is ${new Date().toISOString().split("T")[0]}. You are Tensor,`
);

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
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
  }
}

async function sendTypingAction(chatId: number) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

// Try Gemini API directly first
async function callGemini(userMessage: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT_WITH_DATE }] },
          contents: [{ parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: 4096 },
        }),
      }
    );

    if (!res.ok) {
      console.error("Gemini failed:", await res.text());
      return null;
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch (err) {
    console.error("Gemini error:", err);
    return null;
  }
}

// Fallback to OpenRouter free models
async function callOpenRouter(userMessage: string): Promise<string | null> {
  for (const model of OPENROUTER_FREE_MODELS) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT_WITH_DATE },
            { role: "user", content: userMessage },
          ],
          max_tokens: 4096,
          provider: {
            order: ["Google AI Studio", "Fireworks", "Together"],
            allow_fallbacks: true,
          },
        }),
      });

      if (!res.ok) {
        console.error(`${model} failed:`, await res.text());
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) return content;
    } catch (err) {
      console.error(`${model} error:`, err);
      continue;
    }
  }
  return null;
}

// Try Groq (fastest, most reliable free tier)
async function callGroq(userMessage: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "qwen/qwen3-32b",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_WITH_DATE },
          { role: "user", content: userMessage },
        ],
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      console.error("Groq failed:", await res.text());
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.error("Groq error:", err);
    return null;
  }
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

async function callLLM(userMessage: string): Promise<string> {
  // 1. Try Groq (fastest)
  const groqResult = await callGroq(userMessage);
  if (groqResult) return stripThinkTags(groqResult);

  // 2. Try Gemini direct
  const geminiResult = await callGemini(userMessage);
  if (geminiResult) return geminiResult;

  // 3. Fallback to OpenRouter
  const openRouterResult = await callOpenRouter(userMessage);
  if (openRouterResult) return openRouterResult;

  return "에엣?! 지금 텐삿삐 머리가 좀 과부하야... 잠시 후에 다시 물어봐줘 센빠이! 😱";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("OK", { status: 200 });
  }

  try {
    const update = await req.json();
    const message = update.message;

    if (!message?.text) {
      return new Response("OK", { status: 200 });
    }

    const chatId = message.chat.id;
    const messageId = message.message_id;
    const userText = message.text;

    // Ack with emoji reaction + typing indicator
    await Promise.all([
      fetch(`${TELEGRAM_API}/setMessageReaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: "emoji", emoji: "👀" }],
        }),
      }),
      sendTypingAction(chatId),
    ]);

    // Call LLM
    let reply = await callLLM(userText);

    // Replace self-references with character name before sending
    reply = reply.replace(/\b나는\b/g, "텐삿삐는")
      .replace(/\b나의\b/g, "텐삿삐의")
      .replace(/\b나도\b/g, "텐삿삐도")
      .replace(/\b나가\b/g, "텐삿삐가")
      .replace(/\b내가\b/g, "텐삿삐가");

    // Send response
    await sendTelegramMessage(chatId, reply);

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("Error:", err);
    return new Response("OK", { status: 200 });
  }
});
