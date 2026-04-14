from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx

from agent.nodes.market import fetch_yahoo_market_data, format_market_data
from agent.state import AgentState

try:
    from tavily import AsyncTavilyClient
except ModuleNotFoundError:
    class AsyncTavilyClient:  # type: ignore[no-redef]
        def __init__(self, api_key: str | None = None) -> None:
            self.api_key = api_key

        async def search(
            self,
            query: str,
            max_results: int = 5,
            search_depth: str = "basic",
            include_answer: bool = True,
        ) -> dict[str, Any]:
            if not self.api_key:
                return {"answer": "", "results": []}

            payload = {
                "query": query,
                "max_results": max_results,
                "search_depth": search_depth,
                "include_answer": include_answer,
            }
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }

            async with httpx.AsyncClient(timeout=28.0) as client:
                response = await client.post("https://api.tavily.com/search", headers=headers, json=payload)
                response.raise_for_status()
                return response.json()

THEME_QUERY = "US stock market short-term hot sectors themes momentum today"


def _format_search_result(result: dict[str, Any]) -> dict[str, Any]:
    raw_results: list[dict[str, Any]] = []
    for item in result.get("results", [])[:5]:
        if not isinstance(item, dict):
            continue
        raw_results.append(
            {
                "title": str(item.get("title") or ""),
                "url": str(item.get("url") or ""),
                "content": str(item.get("content") or ""),
            }
        )

    return {
        "summary": str(result.get("answer") or ""),
        "sources": [item["url"] for item in raw_results if item.get("url")],
        "raw_results": raw_results,
    }


def _empty_search_result() -> dict[str, Any]:
    return {
        "summary": "",
        "sources": [],
        "raw_results": [],
    }


async def search_node(state: AgentState) -> dict[str, Any]:
    client = AsyncTavilyClient(api_key=os.getenv("TAVILY_API_KEY"))

    if state["mode"] == "research":
        existing_quotes = state.get("market_quotes")
        market_task = asyncio.sleep(0, result=existing_quotes) if existing_quotes else fetch_yahoo_market_data()
        tasks = await asyncio.gather(
            client.search(
                query=state["user_message"],
                max_results=5,
                search_depth="basic",
                include_answer=True,
            ),
            client.search(
                query=THEME_QUERY,
                max_results=5,
                search_depth="basic",
                include_answer=True,
            ),
            market_task,
            return_exceptions=True,
        )

        base_payload, theme_payload, market_quotes = tasks

        if isinstance(base_payload, Exception):
            print(f"[search] base search failed: {base_payload}")
            search_result = _empty_search_result()
        else:
            search_result = _format_search_result(base_payload)

        if isinstance(theme_payload, Exception):
            print(f"[search] theme search failed: {theme_payload}")
            theme_search_result = _empty_search_result()
        else:
            theme_search_result = _format_search_result(theme_payload)

        if isinstance(market_quotes, Exception):
            print(f"[search] market fetch failed: {market_quotes}")
            market_quotes = None

        return {
            "search_result": search_result,
            "theme_search_result": theme_search_result,
            "market_quotes": market_quotes,
            "market_data_formatted": state.get("market_data_formatted") or (format_market_data(market_quotes) if market_quotes else None),
        }

    try:
        base_result = await client.search(
            query=state["user_message"],
            max_results=5,
            search_depth="basic",
            include_answer=True,
        )
        search_result = _format_search_result(base_result)
    except Exception as error:
        print(f"[search] default search failed: {error}")
        search_result = _empty_search_result()

    return {"search_result": search_result, "theme_search_result": None}
