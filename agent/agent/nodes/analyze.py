from __future__ import annotations

import os
from typing import Any

import httpx

from agent.config import ANSWER_MODELS
from agent.prompts.system import get_analysis_prompt, get_system_prompt
from agent.state import AgentState


async def call_groq_once(
    system_prompt: str,
    user_content: str,
    max_tokens: int = 1500,
    temperature: float = 0.2,
) -> tuple[str | None, bool]:
    groq_api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not groq_api_key:
        return None, False

    rate_limited = False
    timeout = httpx.Timeout(28.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for model in ANSWER_MODELS:
            try:
                response = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {groq_api_key}",
                    },
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_content},
                        ],
                        "max_tokens": max_tokens,
                        "temperature": temperature,
                    },
                )
            except Exception:
                continue

            if response.status_code == 429:
                rate_limited = True
                continue

            if not response.is_success:
                continue

            try:
                data = response.json()
            except ValueError:
                continue

            choices = data.get("choices") or []
            message = choices[0].get("message", {}) if choices else {}
            content = message.get("content")
            if isinstance(content, str) and content.strip():
                return content, False

    return None, rate_limited


def _build_source_titles(search_result: dict[str, object] | None) -> str:
    if not search_result:
        return ""

    raw_results = search_result.get("raw_results") if isinstance(search_result, dict) else None
    titles: list[str] = []
    if isinstance(raw_results, list):
        for item in raw_results[:5]:
            if isinstance(item, dict):
                title = str(item.get("title") or "").strip()
                if title:
                    titles.append(title)

    if titles:
        return ", ".join(titles)

    sources = search_result.get("sources") if isinstance(search_result, dict) else None
    if isinstance(sources, list):
        for source in sources[:5]:
            if isinstance(source, str) and source.strip():
                titles.append(source.strip())
    return ", ".join(titles)


def _build_default_user_content(user_message: str, search_result: dict[str, object] | None) -> str:
    summary = ""
    if isinstance(search_result, dict):
        summary = str(search_result.get("summary") or "")[:1500]

    source_titles = _build_source_titles(search_result)
    return (
        f"Question: {user_message}\n\n"
        f"Search data (use ONLY this data, never invent numbers):\n{summary}\n\n"
        f"Sources: {source_titles}"
    )


def _build_research_user_content(
    user_message: str,
    search_result: dict[str, object] | None,
    theme_search_result: dict[str, object] | None,
    market_data_formatted: str | None,
) -> str:
    base_summary = ""
    theme_summary = ""
    if isinstance(search_result, dict):
        base_summary = str(search_result.get("summary") or "")
    if isinstance(theme_search_result, dict):
        theme_summary = str(theme_search_result.get("summary") or "")
    merged_search_summary = "\n\n".join(
        part for part in [base_summary, theme_summary] if part.strip()
    )
    market_block = market_data_formatted.strip() if market_data_formatted else "No Yahoo market numbers available."

    return (
        f"Question: {user_message}\n\n"
        "Authoritative market numbers (Yahoo only):\n"
        f"{market_block}\n\n"
        "Narrative context from web search (qualitative only):\n"
        f"{merged_search_summary[:1800] or 'No narrative context.'}\n\n"
        "Important:\n"
        '- Use exact numbers ONLY from "Authoritative market numbers (Yahoo only)".\n'
        "- Do not use any numbers from narrative context."
    )


async def analyze_node(state: AgentState) -> dict[str, Any]:
    mode = state.get("mode", "default")
    user_message = state.get("user_message", "")
    search_result = state.get("search_result")
    theme_search_result = state.get("theme_search_result")
    market_data_formatted = state.get("market_data_formatted")

    if mode == "default":
        user_content = _build_default_user_content(user_message, search_result)
        result, rate_limited = await call_groq_once(get_system_prompt(), user_content, 1500, 0.45)
        if result:
            return {"analysis_result": result, "error": None}
        if rate_limited:
            return {"analysis_result": None, "error": "rate_limited"}
        return {"analysis_result": None, "error": "analysis_failed"}

    user_content = _build_research_user_content(
        user_message,
        search_result if isinstance(search_result, dict) else None,
        theme_search_result if isinstance(theme_search_result, dict) else None,
        market_data_formatted,
    )
    result, rate_limited = await call_groq_once(get_analysis_prompt(), user_content, 1500, 0.2)
    if result:
        return {"analysis_result": result, "error": None}
    if rate_limited:
        return {"analysis_result": None, "error": "rate_limited"}
    return {"analysis_result": None, "error": "analysis_failed"}
