from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import asyncio
from pathlib import Path
from collections.abc import AsyncIterator
from typing import Any

import httpx

# This module is the backend read/write facade for the Web UI. It wraps the
# scanner, proxy, logs, runtime files, and editable proxy settings into a single
# API-friendly surface.
ROOT_DIR = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT_DIR / "data"
LOG_DIR = ROOT_DIR / "logs"
KEYS_FILE = DATA_DIR / "keys.txt"
COOKIE_FILE = DATA_DIR / "hc_cookie.json"
RUN_STATS_FILE = DATA_DIR / "run_stats.json"
RUN_STATS_SCRIPT = ROOT_DIR / "scripts" / "run_stats.py"
SCANNER_LOG_FILE = LOG_DIR / "keyhive-scanner.log"
ENV_FILE = ROOT_DIR / ".env"
PROXY_UNIT_FILE = ROOT_DIR / "systemd" / "keyhive-proxy.service"

SCANNER_SERVICE = os.getenv("KEYHIVE_SERVICE", "api-maker-scheduler.service")
PROXY_SERVICE = os.getenv("KEYHIVE_PROXY_SERVICE", "keyhive-proxy.service")
PROXY_URL = os.getenv("KEYHIVE_PROXY_URL", "http://127.0.0.1:8787")
WEB_PORT = int(os.getenv("KEYHIVE_WEB_PORT", "8080"))
WEB_HOST = os.getenv("KEYHIVE_WEB_HOST", "0.0.0.0")

MAX_LOG_LINES = 500
SERVICE_ACTIONS = {"start", "stop", "restart"}
EMAIL_RE = re.compile(r"([A-Za-z0-9._%+-]{2})[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})")
HF_TOKEN_RE = re.compile(r"hf_[A-Za-z0-9_-]{8,}")
ENV_LINE_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$")

FAILURE_KEYWORDS = {
    "cookie_failures": ["cookie", "captcha", "hcaptcha", "hc_cookie"],
    "selector_failures": ["selector", "locator", "element", "waiting for selector"],
    "timeouts": ["timeout", "timed out"],
    "email_failures": ["email", "agentmail", "inbox", "confirmation"],
    "token_failures": ["token", "api key", "access token"],
    "unknown_failures": ["error", "failed", "exception"],
}

# Only these proxy/runtime values are editable from the Web UI. Secrets stay in
# .env and are reported as configured/missing rather than exposed directly.
SETTING_SCHEMA: dict[str, dict[str, Any]] = {
    "KEYHIVE_PROXY_HOST": {"label": "Proxy host", "section": "proxy", "type": "text", "default": "127.0.0.1", "restart": "proxy"},
    "KEYHIVE_PROXY_PORT": {"label": "Proxy port", "section": "proxy", "type": "int", "min": 1, "max": 65535, "default": "8787", "restart": "proxy"},
    "KEYHIVE_PROXY_DEFAULT_PROVIDER": {"label": "Default provider", "section": "models", "type": "select", "options": ["hf", "nvidia"], "default": "hf", "restart": "proxy"},
    "KEYHIVE_PROXY_FALLBACK_PROVIDER": {"label": "Fallback provider", "section": "models", "type": "select", "options": ["nvidia"], "default": "nvidia", "restart": "proxy"},
    "KEYHIVE_FALLBACK_ENABLED": {"label": "Fallback enabled", "section": "models", "type": "bool", "default": "1", "restart": "proxy"},
    "KEYHIVE_FALLBACK_ENTER_AT": {"label": "Fallback enter threshold", "section": "models", "type": "int", "min": 0, "max": 100000, "default": "0", "restart": "proxy"},
    "KEYHIVE_FALLBACK_EXIT_AT": {"label": "Fallback exit threshold", "section": "models", "type": "int", "min": 0, "max": 100000, "default": "10", "restart": "proxy"},
    "KEYHIVE_PROXY_DEFAULT_MODEL": {"label": "Hugging Face default model", "section": "models", "type": "text", "default": "zai-org/GLM-5.2", "restart": "proxy"},
    "KEYHIVE_PROXY_NVIDIA_MODEL": {"label": "NVIDIA fallback model", "section": "models", "type": "text", "default": "moonshotai/kimi-k2.6", "restart": "proxy"},
    "KEYHIVE_PROXY_RELOAD_SECONDS": {"label": "Key reload seconds", "section": "proxy", "type": "int", "min": 1, "max": 3600, "default": "5", "restart": "proxy"},
    "KEYHIVE_PROXY_REQUEST_TIMEOUT": {"label": "Request timeout seconds", "section": "proxy", "type": "float", "min": 1, "max": 1800, "default": "300", "restart": "proxy"},
    "KEYHIVE_PROXY_MAX_RETRIES": {"label": "Max retries", "section": "proxy", "type": "int", "min": 0, "max": 20, "default": "2", "restart": "proxy"},
    "KEYHIVE_PROXY_MAX_KEY_FAILOVERS": {"label": "Max key failovers", "section": "proxy", "type": "int", "min": 0, "max": 100, "default": "3", "restart": "proxy"},
}


def run_command(args: list[str], timeout: float = 8.0) -> dict[str, Any]:
    # Wrap subprocess calls so the web layer can report failures without raising
    # raw exceptions back through FastAPI.
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
    # Query the live systemd state so the dashboard can show whether the scanner
    # and proxy are actually running, not just whether their unit files exist.
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
    # Starting or restarting the scanner also resets run stats so the dashboard
    # buckets line up with the service lifecycle.
    if action not in SERVICE_ACTIONS:
        return {"ok": False, "error": f"unsupported action: {action}"}
    if service == SCANNER_SERVICE and action == "start":
        run_command([sys.executable, str(RUN_STATS_SCRIPT), "ensure"])
    if service == SCANNER_SERVICE and action == "restart":
        run_command([sys.executable, str(RUN_STATS_SCRIPT), "reset-since-restart"])
    result = run_command(["systemctl", action, service], timeout=20.0)
    return {"action": action, "service": service, **result}


def file_mtime(path: Path) -> str | None:
    if not path.exists():
        return None
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(path.stat().st_mtime))


def cookie_info() -> dict[str, Any]:
    # Expose the cookie file age rather than the cookie contents. The contents
    # are sensitive and intentionally never returned here.
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
    # The key file is the scanner's output queue. The web UI only needs counts
    # and modified time, not the raw token values.
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
    # Return a safe fallback when the stats file is missing or unreadable so the
    # dashboard can stay up even if the scanner hasn't written anything yet.
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
    # The web UI uses the local proxy itself as a status source rather than
    # duplicating provider-routing logic in the frontend.
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
    # Prefer the flat scanner log file when it exists because it is faster than
    # shelling out to journalctl for every dashboard refresh.
    if not path.exists():
        return []
    safe_lines = max(1, min(lines, MAX_LOG_LINES))
    content = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return content[-safe_lines:]


def journal_logs(service: str, lines: int) -> list[str]:
    # Fallback to journalctl when the flat log file is absent.
    safe_lines = str(max(1, min(lines, MAX_LOG_LINES)))
    result = run_command(["journalctl", "-u", service, "-b", "-n", safe_lines, "-o", "cat", "--no-pager"], timeout=8.0)
    return result["stdout"].splitlines()


def sanitize_log_lines(lines: list[str]) -> list[str]:
    # Mask email addresses and Hugging Face tokens before logs are shipped to the
    # browser. This is the last safety net before the UI renders text.
    sanitized = []
    for line in lines:
        line = EMAIL_RE.sub(r"\1***\2", line)
        line = HF_TOKEN_RE.sub("hf_***masked***", line)
        sanitized.append(line)
    return sanitized


def log_source(kind: str) -> dict[str, Any]:
    # Scanner logs prefer the repo-local file; proxy logs come from systemd.
    if kind == "scanner" and SCANNER_LOG_FILE.exists():
        return {"kind": "file", "source": str(SCANNER_LOG_FILE), "args": ["tail", "-n", "0", "-F", str(SCANNER_LOG_FILE)]}
    if kind == "scanner":
        return {"kind": "journal", "source": "journalctl", "args": ["journalctl", "-u", SCANNER_SERVICE, "-b", "-n", "0", "-f", "-o", "cat"]}
    return {"kind": "journal", "source": "journalctl", "args": ["journalctl", "-u", PROXY_SERVICE, "-b", "-n", "0", "-f", "-o", "cat"]}


async def stream_logs(kind: str) -> AsyncIterator[str]:
    # SSE log streaming lets the frontend tail logs without polling or keeping a
    # second code path just for "live" mode.
    source = log_source(kind)
    proc = await asyncio.create_subprocess_exec(
        *source["args"],
        cwd=str(ROOT_DIR),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    yield f"event: meta\ndata: {json.dumps({'source': source['source'], 'kind': kind})}\n\n"
    try:
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip("\n")
            payload = {"line": sanitize_log_lines([line])[0], "kind": kind, "ts": time.time()}
            yield f"event: line\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2)
            except asyncio.TimeoutError:
                proc.kill()


def scanner_logs(lines: int) -> dict[str, Any]:
    file_lines = read_log_file(SCANNER_LOG_FILE, lines)
    if file_lines:
        return {"source": str(SCANNER_LOG_FILE), "lines": sanitize_log_lines(file_lines)}
    return {"source": "journalctl", "lines": sanitize_log_lines(journal_logs(SCANNER_SERVICE, lines))}


def proxy_logs(lines: int) -> dict[str, Any]:
    return {"source": "journalctl", "lines": sanitize_log_lines(journal_logs(PROXY_SERVICE, lines))}


def recent_failures() -> list[dict[str, Any]]:
    # Convert the raw failure counters into a compact list for the dashboard.
    stats = run_stats()
    failures = stats.get("all_time", {}).get("failure_points", {})
    updated = stats.get("last_updated")
    last_reason = stats.get("last_failure_reason")
    items = []
    for key, count in failures.items():
        if not count:
            continue
        label = key.replace("_", " ").replace("failures", "failure").title()
        items.append(
            {
                "category": key,
                "label": label,
                "count": count,
                "timestamp": updated,
                "reason": last_reason if key in str(last_reason or "").lower().replace(" ", "_") else label,
            }
        )
    return sorted(items, key=lambda item: int(item["count"]), reverse=True)[:6]


def failure_context(category: str, lines: int = 240, radius: int = 4) -> dict[str, Any]:
    # Pull a small window of nearby scanner log lines around the most recent
    # match so the operator gets context instead of a single cryptic line.
    if category not in FAILURE_KEYWORDS:
        category = "unknown_failures"
    keywords = FAILURE_KEYWORDS[category]
    logs = scanner_logs(lines).get("lines", [])
    matches = [
        index
        for index, line in enumerate(logs)
        if any(keyword in line.lower() for keyword in keywords)
    ]
    if not matches:
        return {
            "category": category,
            "timestamp": run_stats().get("last_updated"),
            "reason": run_stats().get("last_failure_reason") or category.replace("_", " "),
            "source": scanner_logs(1).get("source"),
            "lines": [],
        }
    match = matches[-1]
    start = max(0, match - radius)
    end = min(len(logs), match + radius + 1)
    return {
        "category": category,
        "timestamp": run_stats().get("last_updated"),
        "reason": logs[match],
        "source": scanner_logs(1).get("source"),
        "lines": logs[start:end],
    }


def read_env_values() -> dict[str, str]:
    # Parse .env without sourcing shell code. Only simple KEY=VALUE lines matter
    # for the editable settings view.
    values: dict[str, str] = {}
    if not ENV_FILE.exists():
        return values
    for line in ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
        match = ENV_LINE_RE.match(line)
        if not match:
            continue
        key, value = match.groups()
        values[key] = value.strip().strip('"').strip("'")
    return values


def secret_status(env: dict[str, str]) -> dict[str, Any]:
    # Report whether secrets are configured without leaking their values.
    gmail = env.get("GMAIL_ACCOUNTS", "")
    gmail_count: int | str = 0
    if gmail:
        try:
            parsed = json.loads(gmail)
            gmail_count = len(parsed) if isinstance(parsed, list) else "configured"
        except json.JSONDecodeError:
            gmail_count = "configured"
    return {
        "agentmail_key": "configured" if env.get("AGENTMAIL_API_KEY") else "missing",
        "nvidia_key": "configured" if env.get("NVDA_KEY") else "missing",
        "gmail_accounts": gmail_count,
        "web_password": "configured" if env.get("KEYHIVE_WEB_PASSWORD") or env.get("KEYHIVE_WEB_AUTH_TOKEN") else "missing",
    }


def validate_setting(key: str, value: Any) -> str:
    # Enforce type and bounds before writing back into .env or systemd units.
    schema = SETTING_SCHEMA[key]
    kind = schema["type"]
    if kind == "bool":
        if value in {True, "true", "1", 1, "yes", "on"}:
            return "1"
        if value in {False, "false", "0", 0, "no", "off"}:
            return "0"
        raise ValueError(f"{key} must be boolean")
    value_text = str(value).strip()
    if not value_text:
        raise ValueError(f"{key} cannot be empty")
    if kind in {"int", "float"}:
        number = int(value_text) if kind == "int" else float(value_text)
        if "min" in schema and number < schema["min"]:
            raise ValueError(f"{key} is below minimum")
        if "max" in schema and number > schema["max"]:
            raise ValueError(f"{key} is above maximum")
        return str(number)
    if kind == "select":
        if value_text not in schema["options"]:
            raise ValueError(f"{key} must be one of: {', '.join(schema['options'])}")
        return value_text
    if not re.fullmatch(r"[A-Za-z0-9_./:@+-]+", value_text):
        raise ValueError(f"{key} contains unsupported characters")
    return value_text


def write_env_values(updates: dict[str, str]) -> None:
    # Rewrite only the keys the Web UI owns, preserving unrelated environment
    # values and comments already present in .env.
    lines = ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines() if ENV_FILE.exists() else []
    seen: set[str] = set()
    output: list[str] = []
    for line in lines:
        match = ENV_LINE_RE.match(line)
        if not match or match.group(1) not in updates:
            output.append(line)
            continue
        key = match.group(1)
        output.append(f"{key}={updates[key]}")
        seen.add(key)
    for key, value in updates.items():
        if key not in seen:
            output.append(f"{key}={value}")
    tmp = ENV_FILE.with_suffix(".env.tmp")
    tmp.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(ENV_FILE)


def systemd_unit_path(service: str) -> Path | None:
    # If systemd reports a live unit file path, prefer that over the repo copy.
    status = systemd_service_status(service)
    path = status.get("unit_path")
    if path:
        candidate = Path(str(path))
        if candidate.exists():
            return candidate
    return None


def update_systemd_environment(path: Path, updates: dict[str, str]) -> None:
    # Keep the service files in sync with editable settings so a daemon-reload
    # is enough to pick up the new proxy values.
    if not path.exists():
        return
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    seen: set[str] = set()
    output: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("Environment=") or "=" not in stripped.removeprefix("Environment="):
            output.append(line)
            continue
        key, _value = stripped.removeprefix("Environment=").split("=", 1)
        if key in updates:
            output.append(f"Environment={key}={updates[key]}")
            seen.add(key)
        else:
            output.append(line)
    insert_at = next((index + 1 for index, line in enumerate(output) if line.strip() == "[Service]"), len(output))
    for key, value in updates.items():
        if key not in seen:
            output.insert(insert_at, f"Environment={key}={value}")
            insert_at += 1
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
    tmp.replace(path)


def save_settings(payload: dict[str, Any]) -> dict[str, Any]:
    # The Web UI only writes whitelisted settings, then tells the operator which
    # services need a restart for the change to take effect.
    raw = payload.get("settings", payload)
    if not isinstance(raw, dict):
        raise ValueError("settings payload must be an object")
    updates = {key: validate_setting(key, raw[key]) for key in raw if key in SETTING_SCHEMA}
    if not updates:
        return {"ok": True, "updated": [], "restart_required": []}
    write_env_values(updates)
    update_systemd_environment(PROXY_UNIT_FILE, updates)
    live_unit = systemd_unit_path(PROXY_SERVICE)
    if live_unit and live_unit != PROXY_UNIT_FILE:
        update_systemd_environment(live_unit, updates)
        run_command(["systemctl", "daemon-reload"], timeout=10.0)
    return {"ok": True, "updated": sorted(updates), "restart_required": sorted({SETTING_SCHEMA[key]["restart"] for key in updates})}


def settings() -> dict[str, Any]:
    # Assemble the dashboard's settings payload from .env, systemd, and static
    # defaults so the frontend gets a single coherent view.
    env = read_env_values()
    status = systemd_service_status(PROXY_SERVICE)
    values = {
        key: os.getenv(key) or env.get(key) or schema["default"]
        for key, schema in SETTING_SCHEMA.items()
    }
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
        "editable": values,
        "schema": SETTING_SCHEMA,
        "proxy_unit": str(status.get("unit_path") or PROXY_UNIT_FILE),
        "secrets": secret_status(env),
        "security_warning": "No auth is enabled. Do not expose this long-term without auth and firewall rules.",
    }
