from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx

ROOT_DIR = Path("/root/api_maker")
DATA_DIR = ROOT_DIR / "data"
LOG_DIR = ROOT_DIR / "logs"
KEYS_FILE = DATA_DIR / "keys.txt"
COOKIE_FILE = DATA_DIR / "hc_cookie.json"
RUN_STATS_FILE = DATA_DIR / "run_stats.json"
RUN_STATS_SCRIPT = ROOT_DIR / "scripts" / "run_stats.py"
SCANNER_LOG_FILE = LOG_DIR / "keyhive-scanner.log"

SCANNER_SERVICE = os.getenv("KEYHIVE_SERVICE", "api-maker-scheduler.service")
PROXY_SERVICE = os.getenv("KEYHIVE_PROXY_SERVICE", "keyhive-proxy.service")
PROXY_URL = os.getenv("KEYHIVE_PROXY_URL", "http://127.0.0.1:8787")
WEB_PORT = int(os.getenv("KEYHIVE_WEB_PORT", "8080"))
WEB_HOST = os.getenv("KEYHIVE_WEB_HOST", "0.0.0.0")

MAX_LOG_LINES = 500
SERVICE_ACTIONS = {"start", "stop", "restart"}
EMAIL_RE = re.compile(r"([A-Za-z0-9._%+-]{2})[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})")
HF_TOKEN_RE = re.compile(r"hf_[A-Za-z0-9_-]{8,}")


def run_command(args: list[str], timeout: float = 8.0) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            args,
            cwd=str(ROOT_DIR),
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return {"ok": False, "returncode": 124, "stdout": exc.stdout or "", "stderr": "command timed out"}

    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def systemd_service_status(service: str) -> dict[str, Any]:
    active = run_command(["systemctl", "is-active", service])
    enabled = run_command(["systemctl", "is-enabled", service])
    show = run_command(
        [
            "systemctl",
            "show",
            service,
            "--property=MainPID,ActiveEnterTimestamp,LoadState,SubState,FragmentPath",
        ]
    )
    values = {}
    for line in show["stdout"].splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip()

    return {
        "service": service,
        "active": active["stdout"].strip() or "unknown",
        "enabled": enabled["stdout"].strip() or "unknown",
        "main_pid": values.get("MainPID") or "unknown",
        "since": values.get("ActiveEnterTimestamp") or "unknown",
        "load_state": values.get("LoadState") or "unknown",
        "sub_state": values.get("SubState") or "unknown",
        "unit_path": values.get("FragmentPath") or None,
    }


def control_service(service: str, action: str) -> dict[str, Any]:
    if action not in SERVICE_ACTIONS:
        return {"ok": False, "error": f"unsupported action: {action}"}
    if service == SCANNER_SERVICE and action == "start":
        run_command(["python3", str(RUN_STATS_SCRIPT), "ensure"])
    if service == SCANNER_SERVICE and action == "restart":
        run_command(["python3", str(RUN_STATS_SCRIPT), "reset-since-restart"])
    result = run_command(["systemctl", action, service], timeout=20.0)
    return {"action": action, "service": service, **result}


def file_mtime(path: Path) -> str | None:
    if not path.exists():
        return None
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(path.stat().st_mtime))


def cookie_info() -> dict[str, Any]:
    if not COOKIE_FILE.exists():
        return {"file": str(COOKIE_FILE), "exists": False, "modified": None, "age_seconds": None}

    age_seconds = max(0, int(time.time() - COOKIE_FILE.stat().st_mtime))
    return {
        "file": str(COOKIE_FILE),
        "exists": True,
        "modified": file_mtime(COOKIE_FILE),
        "age_seconds": age_seconds,
        "age_human": f"{age_seconds // 3600}h {(age_seconds % 3600) // 60}m",
    }


def key_stats() -> dict[str, Any]:
    if not KEYS_FILE.exists():
        return {"file": str(KEYS_FILE), "exists": False, "count": 0, "modified": None}

    lines = [line.strip() for line in KEYS_FILE.read_text(encoding="utf-8", errors="replace").splitlines()]
    keys = [line for line in lines if line]
    return {
        "file": str(KEYS_FILE),
        "exists": True,
        "count": len(keys),
        "modified": file_mtime(KEYS_FILE),
    }


def run_stats() -> dict[str, Any]:
    empty_failures = {
        "cookie_failures": 0,
        "selector_failures": 0,
        "timeouts": 0,
        "email_failures": 0,
        "token_failures": 0,
        "unknown_failures": 0,
    }
    fallback = {
        "since_restart": {
            "started_at": None,
            "runs_total": 0,
            "successful_runs": 0,
            "unsuccessful_runs": 0,
            "failure_points": empty_failures,
        },
        "all_time": {
            "runs_total": 0,
            "successful_runs": 0,
            "unsuccessful_runs": 0,
            "failure_points": empty_failures,
        },
        "last_run_status": "unknown",
        "last_failure_reason": None,
        "last_updated": None,
    }

    if not RUN_STATS_FILE.exists():
        return fallback

    try:
        data = json.loads(RUN_STATS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {**fallback, "error": "run_stats.json is unreadable"}

    return data if isinstance(data, dict) else fallback


async def proxy_json(path: str) -> dict[str, Any]:
    url = f"{PROXY_URL.rstrip('/')}/{path.lstrip('/')}"
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            response = await client.get(url)
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {"status": "unexpected_response"}
    except Exception as exc:
        return {"status": "unavailable", "error": exc.__class__.__name__, "url": url}


def read_log_file(path: Path, lines: int) -> list[str]:
    if not path.exists():
        return []
    safe_lines = max(1, min(lines, MAX_LOG_LINES))
    content = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return content[-safe_lines:]


def journal_logs(service: str, lines: int) -> list[str]:
    safe_lines = str(max(1, min(lines, MAX_LOG_LINES)))
    result = run_command(["journalctl", "-u", service, "-b", "-n", safe_lines, "-o", "cat", "--no-pager"], timeout=8.0)
    return result["stdout"].splitlines()


def sanitize_log_lines(lines: list[str]) -> list[str]:
    sanitized = []
    for line in lines:
        line = EMAIL_RE.sub(r"\1***\2", line)
        line = HF_TOKEN_RE.sub("hf_***masked***", line)
        sanitized.append(line)
    return sanitized


def scanner_logs(lines: int) -> dict[str, Any]:
    file_lines = read_log_file(SCANNER_LOG_FILE, lines)
    if file_lines:
        return {"source": str(SCANNER_LOG_FILE), "lines": sanitize_log_lines(file_lines)}
    return {"source": "journalctl", "lines": sanitize_log_lines(journal_logs(SCANNER_SERVICE, lines))}


def proxy_logs(lines: int) -> dict[str, Any]:
    return {"source": "journalctl", "lines": sanitize_log_lines(journal_logs(PROXY_SERVICE, lines))}


def settings() -> dict[str, Any]:
    return {
        "project_path": str(ROOT_DIR),
        "frontend_host": WEB_HOST,
        "frontend_port": WEB_PORT,
        "backend": "same-origin FastAPI app",
        "scanner_service": SCANNER_SERVICE,
        "proxy_service": PROXY_SERVICE,
        "proxy_url": PROXY_URL,
        "runtime_files": {
            "keys": str(KEYS_FILE),
            "cookie": str(COOKIE_FILE),
            "run_stats": str(RUN_STATS_FILE),
            "scanner_log": str(SCANNER_LOG_FILE),
        },
        "security_warning": "No auth is enabled. Do not expose this long-term without auth and firewall rules.",
    }
