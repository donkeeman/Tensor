from __future__ import annotations

import asyncio
from typing import Any

import yfinance as yf

from agent.config import MARKET_LABELS, MARKET_SYMBOLS
from agent.state import AgentState


def _normalize_float(value: Any) -> float:
    try:
        return float(value if value is not None else 0.0)
    except (TypeError, ValueError):
        return 0.0


def _extract_fast_info_value(fast_info: Any, key: str) -> Any:
    try:
        if isinstance(fast_info, dict):
            return fast_info.get(key)
        if hasattr(fast_info, key):
            return getattr(fast_info, key)
        if hasattr(fast_info, "get"):
            return fast_info.get(key)
    except Exception:
        return None
    return None


def _build_quote_from_fast_info(symbol: str, fast_info: Any) -> dict[str, Any] | None:
    last_price = _normalize_float(_extract_fast_info_value(fast_info, "last_price"))
    prev_close = _normalize_float(_extract_fast_info_value(fast_info, "previous_close"))

    if last_price == 0.0 and prev_close == 0.0:
        return None

    change = last_price - prev_close
    change_pct = (change / prev_close * 100.0) if prev_close else 0.0

    return {
        "symbol": symbol,
        "name": symbol,
        "price": last_price,
        "change": change,
        "change_pct": change_pct,
        "prev_close": prev_close,
        "market_state": "UNKNOWN",
    }


def _fetch_quotes_sync(symbols: list[str]) -> list[dict[str, Any]] | None:
    quotes: list[dict[str, Any]] = []

    try:
        tickers = yf.Tickers(" ".join(symbols))
    except Exception as error:
        print(f"[market] failed to initialize yfinance tickers: {error}")
        return None

    for symbol in symbols:
        try:
            ticker = tickers.tickers.get(symbol)
            if ticker is None:
                print(f"[market] missing ticker object: {symbol}")
                continue

            fast_info = ticker.fast_info
            quote = _build_quote_from_fast_info(symbol, fast_info)
            if not quote:
                print(f"[market] fast_info missing price fields: {symbol}")
                continue
            quotes.append(quote)
        except Exception as error:
            print(f"[market] failed to fetch symbol {symbol}: {error}")
            continue

    return quotes or None


async def fetch_yahoo_quotes_by_symbols(symbols: list[str]) -> list[dict[str, Any]] | None:
    filtered_symbols = [symbol for symbol in symbols if symbol]
    if not filtered_symbols:
        return None

    try:
        return await asyncio.to_thread(_fetch_quotes_sync, filtered_symbols)
    except Exception as error:
        print(f"[market] async fetch failed: {error}")
        return None


async def fetch_yahoo_market_data() -> list[dict[str, Any]] | None:
    return await fetch_yahoo_quotes_by_symbols(MARKET_SYMBOLS)


def format_market_data(quotes: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for quote in quotes:
        symbol = str(quote.get("symbol") or "")
        label = MARKET_LABELS.get(symbol, str(quote.get("name") or symbol))
        change = _normalize_float(quote.get("change"))
        change_pct = _normalize_float(quote.get("change_pct"))
        price = _normalize_float(quote.get("price"))
        sign = "+" if change >= 0 else ""

        if symbol == "^TNX":
            lines.append(f"{label}: {price:.3f}% ({sign}{change:.3f}%)")
            continue

        lines.append(f"{label}: {price:,.2f} ({sign}{change_pct:.2f}%)")

    return "\n".join(lines)


def build_snapshot_section_from_yahoo(quotes: list[dict[str, Any]]) -> str:
    line_by_symbol: dict[str, str] = {}

    for quote in quotes:
        symbol = str(quote.get("symbol") or "")
        if not symbol:
            continue

        change = _normalize_float(quote.get("change"))
        change_pct = _normalize_float(quote.get("change_pct"))
        price = _normalize_float(quote.get("price"))
        sign = "+" if change >= 0 else ""

        if symbol == "^TNX":
            line_by_symbol[symbol] = f"• 10년물 금리: {price:.3f}% ({sign}{change:.3f}%)"
            continue

        labels = {
            "^DJI": "Dow Jones",
            "^GSPC": "S&P 500",
            "^IXIC": "Nasdaq",
            "CL=F": "WTI 원유",
            "BZ=F": "브렌트 원유",
        }
        label = labels.get(symbol, str(quote.get("name") or symbol))
        line_by_symbol[symbol] = f"• {label}: {price:,.2f} ({sign}{change_pct:.2f}%)"

    ordered_symbols = ["^DJI", "^GSPC", "^IXIC", "CL=F", "BZ=F", "^TNX"]
    lines = [line_by_symbol[symbol] for symbol in ordered_symbols if symbol in line_by_symbol]

    if not lines:
        return "[시장 스냅샷]\n• Yahoo 숫자 수집이 실패해서 이번엔 숫자 확인이 필요해."

    return "[시장 스냅샷]\n" + "\n".join(lines)


def format_theme_idea_prices_section(quotes: list[dict[str, Any]]) -> str:
    if not quotes:
        return ""

    lines: list[str] = []
    for quote in quotes:
        symbol = str(quote.get("symbol") or "")
        change = _normalize_float(quote.get("change"))
        change_pct = _normalize_float(quote.get("change_pct"))
        price = _normalize_float(quote.get("price"))
        sign = "+" if change >= 0 else ""
        lines.append(f"• {symbol}: ${price:,.2f} ({sign}{change_pct:.2f}%)")

    return "[테마 아이디어 가격 체크]\n" + "\n".join(lines)


def format_fx_section(fx_quote: dict[str, Any] | None) -> str:
    if not fx_quote:
        return ""

    change = _normalize_float(fx_quote.get("change"))
    change_pct = _normalize_float(fx_quote.get("change_pct"))
    price = _normalize_float(fx_quote.get("price"))
    sign = "+" if change >= 0 else ""

    return f"[환율 체크]\n• USD/KRW: {price:.2f} ({sign}{change_pct:.2f}%)"


async def market_node(state: AgentState) -> dict[str, Any]:
    existing_quotes = state.get("market_quotes")
    if existing_quotes:
        return {
            "market_quotes": existing_quotes,
            "market_data_formatted": state.get("market_data_formatted"),
        }

    quotes = await fetch_yahoo_market_data()
    formatted = format_market_data(quotes) if quotes else None
    return {
        "market_quotes": quotes,
        "market_data_formatted": formatted,
    }
