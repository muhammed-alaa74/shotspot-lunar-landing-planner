"""FastAPI entrypoint for SHOTSPOT Copilot."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from .copilot.config import get_settings, limiter
from .copilot.router import router as copilot_router

settings = get_settings()
app = FastAPI(title="SHOTSPOT Copilot API", version="1.0.0", docs_url="/docs", redoc_url="/redoc")
app.state.limiter = limiter


def rate_limit_handler(request: Request, exc: Exception) -> Response:
    if isinstance(exc, RateLimitExceeded):
        return _rate_limit_exceeded_handler(request, exc)
    return JSONResponse(status_code=429, content={"detail": "Too many requests. Please retry shortly."})


app.add_exception_handler(RateLimitExceeded, rate_limit_handler)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    # Pydantic's default body echoes invalid input (which may contain a secret)
    # and can expose implementation detail. Keep the public 422 contract small.
    return JSONResponse(status_code=422, content={"detail": "Invalid Copilot request"})


app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def request_guard(request: Request, call_next):
    if request.url.path == "/api/copilot" and request.method == "POST":
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError:
                return JSONResponse(status_code=400, content={"detail": "Invalid request headers"})
            if declared_length > settings.max_request_bytes:
                return JSONResponse(status_code=413, content={"detail": "Request is too large"})
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > settings.max_request_bytes:
                return JSONResponse(status_code=413, content={"detail": "Request is too large"})
            body.extend(chunk)
        request._body = bytes(body)  # Starlette reuses this cache in call_next.
    return await call_next(request)


@app.get("/api/health", tags=["health"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(copilot_router)
