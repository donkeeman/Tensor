ANSWER_MODELS = ["qwen/qwen3-32b", "moonshotai/kimi-k2-instruct", "llama-3.3-70b-versatile"]

MARKET_SYMBOLS = ["^DJI", "^GSPC", "^IXIC", "CL=F", "BZ=F", "^TNX"]

FX_SYMBOL = "KRW=X"

MARKET_LABELS = {
    "^DJI": "Dow Jones",
    "^GSPC": "S&P 500",
    "^IXIC": "Nasdaq",
    "CL=F": "WTI Crude",
    "BZ=F": "Brent Crude",
    "^TNX": "10-Year Treasury Yield",
}

THEME_KEYWORDS = ["테마", "트렌드", "섹터", "요즘 뭐", "핫한", "theme", "themes", "sector", "sectors", "trend", "trends", "momentum"]

MAX_RETRIES = 2
