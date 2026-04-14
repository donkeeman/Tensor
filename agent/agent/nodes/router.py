from __future__ import annotations

from agent.config import THEME_KEYWORDS
from agent.state import AgentState


def router_node(state: AgentState) -> dict:
    lower = state["user_message"].lower()
    mode = "research" if any(keyword in lower for keyword in THEME_KEYWORDS) else "default"
    return {"mode": mode}
