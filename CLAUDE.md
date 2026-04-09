# Tensor — Development Guide

Technical guidelines for developing the Tensor agent. For persona and system prompt details, see `prompts/tensor_system_prompt.md`.

## Stack & Tools
- **Primary**: Python (yfinance, etc.), Telegram API
- **Prompt management**: Markdown files in `prompts/`

## Commands (tentative)
- **Manual data collection**: `python scripts/fetch_market_data.py`
- **Prompt testing**: `python scripts/test_prompt.py`

## Code Style
- **Naming**: snake_case (e.g., `get_portfolio_data`)
- **Comments**: Required for complex logic and data processing steps
- **Error handling**: Always wrap external API calls (yfinance, web search) with exception handling

## Testing Strategy
1. **Data validation**: Verify fetched price data matches actual market data
2. **Risk alerts**: Confirm warning logic triggers correctly on high portfolio concentration
