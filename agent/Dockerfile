# =============================================================================
# 스테이지 1: 빌드 — 의존성 설치 + 패키지 빌드
# =============================================================================
FROM python:3.11-slim AS builder

# 빌드 타임 시스템 패키지 (컴파일 도구)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# 의존성 파일만 먼저 복사 → 소스 변경 시 레이어 캐시 재사용
COPY pyproject.toml ./

# pip 업그레이드 후 프로젝트 의존성 설치 (소스 없이 의존성만)
RUN pip install --upgrade pip \
    && pip install --no-cache-dir \
        "langgraph>=0.4" \
        "tavily-python>=0.5" \
        "yfinance>=0.2" \
        "fastapi>=0.115" \
        "uvicorn>=0.34" \
        "python-dotenv>=1" \
        "httpx>=0.28"


# =============================================================================
# 스테이지 2: 런타임 — 최소 이미지로 복사
# =============================================================================
FROM python:3.11-slim AS runtime

# 런타임 환경 변수
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

# 런타임 시스템 패키지 (yfinance HTTPS 요청에 필요한 CA 인증서)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# 보안: 비루트 사용자 생성
RUN groupadd --gid 1001 appgroup \
    && useradd --uid 1001 --gid appgroup --no-create-home appuser

WORKDIR /app

# 빌더 스테이지에서 설치된 Python 패키지만 복사
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# 소스 코드 복사
COPY main.py ./
COPY agent/ ./agent/

# 파일 소유권을 비루트 사용자로 변경
RUN chown -R appuser:appgroup /app

# 비루트 사용자로 전환
USER appuser

# 헬스체크: FastAPI GET / 엔드포인트 확인 (30초 간격, 타임아웃 5초)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:${PORT}/ || exit 1

EXPOSE ${PORT}

# PORT 환경변수를 런타임에 shell로 치환하기 위해 sh -c 사용
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
