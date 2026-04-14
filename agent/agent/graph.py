from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from agent.nodes.analyze import analyze_node
from agent.nodes.postprocess import postprocess_node
from agent.nodes.router import router_node
from agent.nodes.search import search_node
from agent.nodes.translate import translate_node
from agent.state import AgentState


def build_graph():
    workflow = StateGraph(AgentState)

    workflow.add_node("router", router_node)
    workflow.add_node("search", search_node)
    workflow.add_node("analyze", analyze_node)
    workflow.add_node("translate", translate_node)
    workflow.add_node("postprocess", postprocess_node)

    workflow.add_edge(START, "router")
    workflow.add_edge("router", "search")
    workflow.add_edge("search", "analyze")
    workflow.add_edge("analyze", "translate")
    workflow.add_edge("translate", "postprocess")
    workflow.add_edge("postprocess", END)

    return workflow.compile()


graph = build_graph()
