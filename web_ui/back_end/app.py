from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from web_ui.back_end.services import keyhive_service as keyhive

FRONT_END_DIR = Path("/root/api_maker/web_ui/front_end")
ASSETS_DIR = Path("/root/api_maker/assets")

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

app.mount("/static", StaticFiles(directory=str(FRONT_END_DIR)), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(FRONT_END_DIR / "index.html")


@app.head("/")
async def index_head() -> FileResponse:
    return FileResponse(FRONT_END_DIR / "index.html")


@app.get("/api/status")
async def status() -> dict[str, Any]:
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


@app.get("/api/settings")
async def settings() -> dict[str, Any]:
    return keyhive.settings()


@app.post("/api/scanner/{action}")
async def scanner_control(action: str) -> dict[str, Any]:
    if action not in keyhive.SERVICE_ACTIONS:
        raise HTTPException(status_code=404, detail="unsupported scanner action")
    return keyhive.control_service(keyhive.SCANNER_SERVICE, action)


@app.post("/api/proxy/{action}")
async def proxy_control(action: str) -> dict[str, Any]:
    if action not in keyhive.SERVICE_ACTIONS:
        raise HTTPException(status_code=404, detail="unsupported proxy action")
    return keyhive.control_service(keyhive.PROXY_SERVICE, action)
