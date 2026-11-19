"""Configuration for the SHOTSPOT Copilot backend."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from slowapi import Limiter
from slowapi.util import get_remote_address

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if load_dotenv:
    load_dotenv(ROOT / ".env", override=False)
    load_dotenv(BACKEND / ".env", override=False)


@dataclass(frozen=True)
class Settings:
    groq_api_key: str | None
    groq_model: str
    groq_fallback_model: str
    temperature: float
    max_tokens: int
    timeout_seconds: float
    max_retries: int
    cors_origins: tuple[str, ...]
    rate_limit_per_minute: int
    max_request_bytes: int
    max_history_messages: int


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    origins = os.getenv(
        "COPILOT_CORS_ORIGINS",
        os.getenv("CORS_ORIGINS", "http://localhost:3000,http://localhost:4200,http://localhost:5174"),
    )
    parsed_origins = tuple(x.strip() for x in origins.split(",") if x.strip() and x.strip() != "*")
    for name in ("groq", "httpx", "httpcore", "openai"):
        logging.getLogger(name).setLevel(logging.WARNING)
    return Settings(
        groq_api_key=os.getenv("GROQ_API_KEY") or None,
        groq_model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
        groq_fallback_model=os.getenv("GROQ_FALLBACK_MODEL", "llama-3.1-8b-instant"),
        temperature=0.2,
        max_tokens=700,
        timeout_seconds=20.0,
        max_retries=0,
        cors_origins=parsed_origins,
        rate_limit_per_minute=max(1, int(os.getenv("COPILOT_RATE_LIMIT", "20"))),
        max_request_bytes=max(1024, int(os.getenv("COPILOT_MAX_REQUEST_BYTES", "131072"))),
        max_history_messages=10,
    )


# A single process-local limiter is bounded by SlowAPI's storage and keyed by
# the explicit Starlette request in the route. It replaces the old unbounded
# per-IP deque.
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri="memory://",
    default_limits=[f"{get_settings().rate_limit_per_minute}/minute"],
    headers_enabled=False,
)


class CopilotConfigurationError(RuntimeError):
    """A safe, user-facing configuration failure."""

    pass
