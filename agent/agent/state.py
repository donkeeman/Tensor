from typing import Literal, TypedDict


class AgentState(TypedDict):
    # 사용자 입력 텍스트
    user_message: str
    # Telegram chat ID
    chat_id: int
    # Telegram message ID (리액션용)
    message_id: int
    # 진행 상황 메시지 ID
    status_message_id: int | None
    # 라우팅 결과
    mode: Literal["default", "research"]
    # {"summary": str, "sources": list[str]}
    search_result: dict | None
    # research 모드 추가 검색
    theme_search_result: dict | None
    # Yahoo Finance 데이터
    market_quotes: list[dict] | None
    # 포맷된 시장 데이터 문자열
    market_data_formatted: str | None
    # LLM 영어 분석(research) 또는 한국어 직접 답변(default)
    analysis_result: str | None
    # 한국어 번역 결과
    translated_result: str | None
    # 섹션 검증 재시도 횟수
    retry_count: int
    # 후처리 완료된 최종 응답
    final_reply: str | None
    # 에러 메시지
    error: str | None
