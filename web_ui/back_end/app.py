from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from web_ui.back_end.services import keyhive_service as keyhive
from web_ui.back_end.services import auth_service

# This FastAPI app is the Web UI surface. It serves static files and forwards
# status/control calls to the existing scanner and proxy services.
ROOT_DIR = Path(__file__).resolve().parents[2]
FRONT_END_DIR = ROOT_DIR / "web_ui" / "front_end"
ASSETS_DIR = ROOT_DIR / "assets"

app = FastAPI(
    title="KeyHive Web UI",
    description=(
        "Unauthenticated KeyHive control surface. Temporary only; put this behind auth/firewalling "
        "before exposing it long-term."
    ),
    version="0.1.0",
)

if ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")

# The frontend is static, so FastAPI just serves the files and exposes the API.
app.mount("/static", StaticFiles(directory=str(FRONT_END_DIR)), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(FRONT_END_DIR / "index.html")


@app.head("/")
async def index_head() -> FileResponse:
    return FileResponse(FRONT_END_DIR / "index.html")


@app.get("/login")
async def login() -> FileResponse:
    return FileResponse(FRONT_END_DIR / "login.html")


@app.head("/login")
async def login_head() -> FileResponse:
    return FileResponse(FRONT_END_DIR / "login.html")


@app.get("/api/auth/config")
async def auth_config() -> dict[str, object]:
    return auth_service.auth_config()


@app.post("/api/auth/login")
async def auth_login(payload: dict[str, str]) -> dict[str, object]:
    # This validates the configured secret, but it does not yet create a real
    # authenticated session. The frontend is blunt about that limitation.
    if auth_service.verify_login(str(payload.get("secret", ""))):
        return {"ok": True, "protects_ui": False}
    raise HTTPException(status_code=401, detail="Invalid password or token")


@app.get("/api/status")
async def status() -> dict[str, Any]:
    # Aggregate the scanner, proxy, key, cookie, and run state into one payload
    # so the dashboard can paint everything with a single request.
    proxy_health = await keyhive.proxy_json("/health")
    proxy_stats = await keyhive.proxy_json("/stats")
    return {
        "scanner": keyhive.systemd_service_status(keyhive.SCANNER_SERVICE),
        "proxy": keyhive.systemd_service_status(keyhive.PROXY_SERVICE),
        "proxy_health": proxy_health,
        "proxy_stats": proxy_stats,
        "keys": keyhive.key_stats(),
        "cookie": keyhive.cookie_info(),
        "runs": keyhive.run_stats(),
        "settings": keyhive.settings(),
    }


@app.get("/api/scanner/status")
async def scanner_status() -> dict[str, Any]:
    return {
        "service": keyhive.systemd_service_status(keyhive.SCANNER_SERVICE),
        "keys": keyhive.key_stats(),
        "cookie": keyhive.cookie_info(),
        "runs": keyhive.run_stats(),
    }


@app.get("/api/proxy/status")
async def proxy_status() -> dict[str, Any]:
    return {
        "service": keyhive.systemd_service_status(keyhive.PROXY_SERVICE),
        "health": await keyhive.proxy_json("/health"),
    }


@app.get("/api/proxy/stats")
async def proxy_stats() -> dict[str, Any]:
    return await keyhive.proxy_json("/stats")


@app.get("/api/proxy/fallback")
async def proxy_fallback() -> dict[str, Any]:
    stats = await keyhive.proxy_json("/stats")
    return {
        "current_provider": stats.get("current_provider", "unknown"),
        "fallback_enabled": stats.get("fallback_enabled"),
        "fallback_provider": stats.get("fallback_provider"),
        "fallback_reason": stats.get("fallback_reason"),
        "fallback_enter_at": stats.get("fallback_enter_at"),
        "fallback_exit_at": stats.get("fallback_exit_at"),
        "nvidia_available": stats.get("nvidia_available"),
        "nvidia_model": stats.get("nvidia_model"),
        "hf_usable_keys": stats.get("hf_usable_keys", stats.get("keys_available", 0)),
    }


@app.get("/api/keys/stats")
async def keys_stats() -> dict[str, Any]:
    return keyhive.key_stats()


@app.get("/api/runs/stats")
async def runs_stats() -> dict[str, Any]:
    return keyhive.run_stats()


@app.get("/api/logs/scanner")
async def logs_scanner(lines: int = Query(default=100, ge=1, le=500)) -> dict[str, Any]:
    return keyhive.scanner_logs(lines)


@app.get("/api/logs/proxy")
async def logs_proxy(lines: int = Query(default=100, ge=1, le=500)) -> dict[str, Any]:
    return keyhive.proxy_logs(lines)


@app.get("/api/logs/{kind}/stream")
async def logs_stream(kind: str) -> StreamingResponse:
    # Only scanner and proxy logs are exposed as SSE streams. Other kinds would
    # need dedicated implementation, not a free-for-all parameter.
    if kind not in {"scanner", "proxy"}:
        raise HTTPException(status_code=404, detail="unsupported log stream")
    return StreamingResponse(
        keyhive.stream_logs(kind),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/failures/recent")
async def failures_recent() -> list[dict[str, Any]]:
    return keyhive.recent_failures()


@app.get("/api/failures/{category}")
async def failures_context(category: str) -> dict[str, Any]:
    return keyhive.failure_context(category)


@app.get("/api/settings")
async def settings() -> dict[str, Any]:
    return keyhive.settings()


@app.post("/api/settings")
async def save_settings(payload: dict[str, Any]) -> dict[str, Any]:
    # Validation errors are surfaced as 400s so the frontend can render a sane
    # message instead of a stack trace.
    try:
        return keyhive.save_settings(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/scanner/{action}")
async def scanner_control(action: str) -> dict[str, Any]:
    # The UI only allows the explicit start/stop/restart actions that the shared
    # service helper knows how to run safely.
    if action not in keyhive.SERVICE_ACTIONS:
        raise HTTPException(status_code=404, detail="unsupported scanner action")
    return keyhive.control_service(keyhive.SCANNER_SERVICE, action)


@app.post("/api/proxy/{action}")
async def proxy_control(action: str) -> dict[str, Any]:
    if action not in keyhive.SERVICE_ACTIONS:
        raise HTTPException(status_code=404, detail="unsupported proxy action")
    return keyhive.control_service(keyhive.PROXY_SERVICE, action)
