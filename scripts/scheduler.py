#!/usr/bin/env python3
"""
scheduler.py — Runs hf_keys.js 10 times per 90-minute cycle (every 9 minutes)
"""

import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

from run_stats import ensure_stats_file, record_run

ROOT_DIR = Path("/root/api_maker")
SCRIPT_DIR = Path("/root/api_maker/scripts")
HF_KEYS_JS = SCRIPT_DIR / "hf_keys.js"
LOG_DIR = ROOT_DIR / "logs"
RUNS_PER_CYCLE = 10
INTERVAL_SECONDS = 9 * 60  # 9 minutes


def ensure_runtime_paths() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def fmt_dt(dt: datetime) -> str:
    return dt.strftime("%H:%M:%S %d/%m/%Y")


def emit(message: str = "") -> None:
    ensure_runtime_paths()
    print(message, flush=True)


def emit_raw(text: str) -> None:
    ensure_runtime_paths()
    print(text, end="", flush=True)


def run_hf_keys(run_number: int) -> None:
    now = datetime.now()
    header = f"==={fmt_dt(now)}, run {run_number}==="
    emit(header)

    proc = subprocess.Popen(
        ["node", str(HF_KEYS_JS)],
        cwd=str(SCRIPT_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    output_lines = []
    for line in proc.stdout:
        output_lines.append(line)
        emit_raw(line)

    return_code = proc.wait()
    output = "".join(output_lines)
    failure_reason = record_run(output, return_code)
    success = failure_reason is None

    if success:
        emit(f"===run {run_number} status: success===")
    else:
        emit(f"===run {run_number} status: failure ({failure_reason})===")

    if run_number < RUNS_PER_CYCLE:
        emit(f"===end of run {run_number}===\n")
    else:
        next_run = datetime.now() + timedelta(minutes=90)
        emit(f"===End of run {run_number}. Next run at {fmt_dt(next_run)}===\n")


def main():
    ensure_runtime_paths()
    ensure_stats_file()
    emit(f"Scheduler started - {fmt_dt(datetime.now())}")
    emit(f"Cycle: {RUNS_PER_CYCLE} runs x {INTERVAL_SECONDS // 60}min intervals\n")

    while True:
        cycle_start = time.monotonic()

        for run in range(1, RUNS_PER_CYCLE + 1):
            run_start = time.monotonic()

            run_hf_keys(run)

            if run < RUNS_PER_CYCLE:
                elapsed = time.monotonic() - run_start
                sleep_for = max(0, INTERVAL_SECONDS - elapsed)
                next_run_time = datetime.now() + timedelta(seconds=sleep_for)
                emit(f"Next run at {fmt_dt(next_run_time)}\n")
                time.sleep(sleep_for)

        # Wait out the remainder of the 90-min window before next cycle
        cycle_elapsed = time.monotonic() - cycle_start
        cycle_remainder = max(0, (90 * 60) - cycle_elapsed)
        if cycle_remainder > 0:
            next_cycle = datetime.now() + timedelta(seconds=cycle_remainder)
            emit(f"Cycle complete. Next cycle at {fmt_dt(next_cycle)}\n")
            time.sleep(cycle_remainder)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        emit("\nScheduler stopped.")
        sys.exit(0)
