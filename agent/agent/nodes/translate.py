from __future__ import annotations

import re
from typing import Any

from agent.config import MAX_RETRIES
from agent.nodes.analyze import call_groq_once
from agent.prompts.system import RESEARCH_TRANSLATE_PROMPT
from agent.state import AgentState


REQUIRED_SECTIONS = [
    "[시장 스냅샷]",
    "[왜 움직였는지]",
    "[핫한 테마 (단기 1~2주)]",
    "[테마 아이디어 (조건부)]",
]


def has_research_sections(text: str) -> bool:
    return all(header in text for header in REQUIRED_SECTIONS)


def ensure_research_sections(text: str) -> str:
    result = text.strip()
    if "[핫한 테마 (단기 1~2주)]" not in result:
        result = f"[핫한 테마 (단기 1~2주)]\n• 단기 테마 신호가 약해서 보수적으로 볼게.\n\n{result}"
    if "[테마 아이디어 (조건부)]" not in result:
        result += "\n\n[테마 아이디어 (조건부)]\n• 오늘은 근거가 약해서 예시 종목/ETF는 생략할게."
    if "[왜 움직였는지]" not in result:
        result += "\n\n[왜 움직였는지]\n• 오늘 뉴스 맥락 근거가 제한적이라 단정은 피할게."
    if "[시장 스냅샷]" not in result:
        result += "\n\n[시장 스냅샷]\n• 오늘 핵심 숫자는 본문에서 다시 확인해줘."
    return result


def get_research_section_body(text: str, header: str) -> str:
    escaped_header = re.escape(header)
    other_headers_pattern = "|".join(re.escape(item) for item in REQUIRED_SECTIONS if item != header)
    pattern = re.compile(rf"{escaped_header}\s*([\s\S]*?)(?=\n(?:{other_headers_pattern})|$)")
    match = pattern.search(text)
    return match.group(1) if match else ""


def has_numeric_claims_outside_snapshot(text: str) -> bool:
    targets = ["[왜 움직였는지]", "[핫한 테마 (단기 1~2주)]", "[테마 아이디어 (조건부)]"]
    numeric_pattern = re.compile(r"(?:\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?%)")
    return any(numeric_pattern.search(get_research_section_body(text, header)) for header in targets)


async def translate_node(state: AgentState) -> dict[str, Any]:
    if state.get("mode") == "default":
        return {"translated_result": state["analysis_result"]}

    english = state.get("analysis_result")
    if not english:
        return {"translated_result": None, "retry_count": 0, "error": "분석 결과 없음"}

    korean, rate_limited = await call_groq_once(
        RESEARCH_TRANSLATE_PROMPT,
        f"Translate this financial analysis to Korean as 텐삿삐:\n\n{english}",
        max_tokens=1500,
        temperature=0.55,
    )
    if not korean:
        return {
            "translated_result": None,
            "retry_count": 0,
            "error": "rate_limited" if rate_limited else "translate_failed",
        }

    if has_research_sections(korean):
        return {"translated_result": korean, "retry_count": 0}

    rewrite, rewrite_rate_limited = await call_groq_once(
        RESEARCH_TRANSLATE_PROMPT,
        (
            "Rewrite this Korean draft to satisfy the exact section format with all 4 headers.\n\n"
            f"Draft:\n{korean}\n\n"
            f"Source English analysis:\n{english}"
        ),
        max_tokens=1500,
        temperature=0.45,
    )
    if not rewrite:
        fallback = ensure_research_sections(korean)
        retry_count = min(1, MAX_RETRIES)
        if has_numeric_claims_outside_snapshot(fallback):
            fallback += "\n\n[검증 메모]\n• 숫자 혼입 가능성이 보여서 [시장 스냅샷] 외 수치는 보수적으로 해석해줘."
        return {
            "translated_result": fallback,
            "retry_count": retry_count,
            "error": None if not rewrite_rate_limited else "rate_limited",
        }

    final_research = ensure_research_sections(rewrite)
    retry_count = min(1, MAX_RETRIES)
    if has_numeric_claims_outside_snapshot(final_research):
        cleaned, cleaned_rate_limited = await call_groq_once(
            RESEARCH_TRANSLATE_PROMPT,
            (
                "Rewrite this Korean briefing so that exact numbers appear ONLY inside [시장 스냅샷].\n"
                "Keep all tickers unchanged.\n"
                "Do not add any new numbers outside [시장 스냅샷].\n\n"
                f"Text:\n{final_research}"
            ),
            max_tokens=1500,
            temperature=0.35,
        )
        if cleaned:
            final_research = ensure_research_sections(cleaned)
            retry_count = min(2, MAX_RETRIES)
        elif cleaned_rate_limited:
            retry_count = min(2, MAX_RETRIES)

    return {"translated_result": final_research, "retry_count": retry_count}
