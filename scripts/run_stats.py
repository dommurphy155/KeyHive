#!/usr/bin/env python3
"""Persistent KeyHive scanner run statistics."""

import json
import fcntl
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

# This file is the bookkeeping layer for scanner runs. It keeps both
# since-restart and all-time counters so the CLI and web UI can report the same
# numbers without parsing logs repeatedly.
ROOT_DIR = Path("/root/api_maker")
STATS_FILE = ROOT_DIR / "data" / "run_stats.json"
LOCK_FILE = ROOT_DIR / "data" / "run_stats.lock"

FAILURE_LABELS = (
    ("cookie_failures", "Cookie Failures:"),
    ("selector_failures", "Selector Failures:"),
    ("timeouts", "Timeouts:"),
    ("email_failures", "Email Failures:"),
    ("token_failures", "Token Failures:"),
    ("unknown_failures", "Unknown Failures:"),
)

FAILURE_PATTERNS = {
    "cookie_failures": (
        "failed to refresh cookie",
        "cookie refresh failed",
        "hc_cookie not found",
        "unexpected end of json input",
        "unexpected token",
    ),
    "timeouts": (
        "timeout",
        "timed out",
        "cdp never came alive",
    ),
    "email_failures": (
        "failed to get burner email",
        "failed to get confirmation link",
        "no confirmation link",
        "no confirmation email",
    ),
    "selector_failures": (
        "create account button not found",
        "locator.",
        "waiting for selector",
    ),
    "token_failures": (
        "could not extract hf token",
    ),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def empty_bucket(started_at: str | None = None) -> dict:
    bucket = {
        "runs_total": 0,
        "successful_runs": 0,
        "unsuccessful_runs": 0,
        "failure_points": {key: 0 for key, _label in FAILURE_LABELS},
    }
    if started_at is not None:
        bucket["started_at"] = started_at
    return bucket


def default_stats() -> dict:
    return {
        "since_restart": empty_bucket(utc_now()),
        "all_time": empty_bucket(),
        "last_run_status": None,
        "last_failure_reason": None,
        "last_updated": None,
    }


def normalize_bucket(raw: object, include_started_at: bool = False) -> dict:
    source = raw if isinstance(raw, dict) else {}
    bucket = empty_bucket(source.get("started_at") if include_started_at else None)
    if include_started_at and not bucket.get("started_at"):
        bucket["started_at"] = utc_now()

    for key in ("runs_total", "successful_runs", "unsuccessful_runs"):
        try:
            bucket[key] = int(source.get(key, 0) or 0)
        except (TypeError, ValueError):
            bucket[key] = 0

    raw_failures = source.get("failure_points", {})
    if isinstance(raw_failures, dict):
        for key in bucket["failure_points"]:
            try:
                bucket["failure_points"][key] = int(raw_failures.get(key, 0) or 0)
            except (TypeError, ValueError):
                bucket["failure_points"][key] = 0

    return bucket


def migrate_flat_stats(raw: dict) -> dict:
    # Older stats files were flat. This migration keeps them readable instead of
    # breaking the dashboard the first time it sees an old JSON shape.
    return {
        "since_restart": empty_bucket(utc_now()),
        "all_time": normalize_bucket(raw),
        "last_run_status": raw.get("last_run_status"),
        "last_failure_reason": raw.get("last_failure_reason"),
        "last_updated": raw.get("last_updated"),
    }


def read_stats() -> dict:
    if not STATS_FILE.exists():
        return default_stats()

    try:
        raw = json.loads(STATS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default_stats()

    if not isinstance(raw, dict):
        return default_stats()

    if "all_time" not in raw and "since_restart" not in raw:
        return migrate_flat_stats(raw)

    return {
        "since_restart": normalize_bucket(raw.get("since_restart"), include_started_at=True),
        "all_time": normalize_bucket(raw.get("all_time")),
        "last_run_status": raw.get("last_run_status"),
        "last_failure_reason": raw.get("last_failure_reason"),
        "last_updated": raw.get("last_updated"),
    }


def write_stats(stats: dict) -> None:
    # Write through a temporary file so stats updates are atomic on disk.
    STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp_file = STATS_FILE.with_suffix(".json.tmp")
    temp_file.write_text(json.dumps(stats, indent=2) + "\n", encoding="utf-8")
    temp_file.replace(STATS_FILE)


@contextmanager
def stats_lock():
    # The scheduler and manual runs can update stats concurrently, so this lock
    # prevents one process from clobbering another's counters.
    STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_FILE.open("w", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def ensure_stats_file() -> None:
    with stats_lock():
        write_stats(read_stats())


def reset_since_restart() -> None:
    with stats_lock():
        stats = read_stats()
        stats["since_restart"] = empty_bucket(utc_now())
        write_stats(stats)


def classify_failure(output: str, return_code: int) -> str | None:
    # The caller records broad failure classes instead of trying to preserve
    # every possible error string verbatim.
    lowered = output.lower()
    if return_code == 0 and "saved to /root/api_maker/data/keys.txt" in lowered:
        return None

    for category, patterns in FAILURE_PATTERNS.items():
        if any(pattern in lowered for pattern in patterns):
            return category

    return "unknown_failures"


def increment_bucket(bucket: dict, success: bool, failure_reason: str | None) -> None:
    bucket["runs_total"] += 1
    if success:
        bucket["successful_runs"] += 1
        return

    reason = failure_reason or "unknown_failures"
    bucket["unsuccessful_runs"] += 1
    bucket["failure_points"][reason] = bucket["failure_points"].get(reason, 0) + 1


def record_run(output: str, return_code: int) -> str | None:
    # Record both the since-restart bucket and the all-time bucket in one locked
    # transaction so the dashboard does not briefly report nonsense.
    with stats_lock():
        stats = read_stats()
        failure_reason = classify_failure(output, return_code)
        success = failure_reason is None

        increment_bucket(stats["since_restart"], success, failure_reason)
        increment_bucket(stats["all_time"], success, failure_reason)

        stats["last_run_status"] = "success" if success else "failure"
        stats["last_failure_reason"] = None if success else failure_reason
        stats["last_updated"] = utc_now()
        write_stats(stats)
        return failure_reason


def print_bucket(title: str, bucket: dict) -> None:
    print(f"\n{title}")
    if "started_at" in bucket:
        print(f"  {'Started At:':<20} {bucket.get('started_at') or 'unknown'}")
    print(f"  {'Runs Total:':<20} {bucket.get('runs_total', 0)}")
    print(f"  {'Successful Runs:':<20} {bucket.get('successful_runs', 0)}")
    print(f"  {'Unsuccessful Runs:':<20} {bucket.get('unsuccessful_runs', 0)}")
    print("  Failure Points:")
    failures = bucket.get("failure_points", {})
    for key, label in FAILURE_LABELS:
        print(f"    {label:<18} {failures.get(key, 0)}")


def print_status() -> None:
    stats = read_stats()
    print_bucket("SINCE RESTART", stats["since_restart"])
    print_bucket("ALL TIME RUNS", stats["all_time"])
    print(f"\n  {'Last Status:':<20} {stats.get('last_run_status') or 'unknown'}")
    print(f"  {'Last Failure:':<20} {stats.get('last_failure_reason') or 'none'}")
    print(f"  {'Last Updated:':<20} {stats.get('last_updated') or 'never'}")


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "status"

    if command == "ensure":
        ensure_stats_file()
        return 0

    if command == "reset-since-restart":
        reset_since_restart()
        return 0

    if command == "record":
        if len(sys.argv) != 4:
            print("usage: run_stats.py record <return_code> <output_file>", file=sys.stderr)
            return 2
        return_code = int(sys.argv[2])
        output = Path(sys.argv[3]).read_text(encoding="utf-8", errors="replace")
        reason = record_run(output, return_code)
        print("success" if reason is None else reason)
        return 0

    if command == "status":
        print_status()
        return 0

    print(f"unknown command: {command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
