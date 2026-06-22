#!/usr/bin/env python3
"""
scheduler.py — Runs hf_keys.js 10 times per 90-minute cycle (every 9 minutes)
"""

import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

SCRIPT_DIR = Path("/root/api_maker/scripts")
HF_KEYS_JS = SCRIPT_DIR / "hf_keys.js"
RUNS_PER_CYCLE = 10
INTERVAL_SECONDS = 9 * 60  # 9 minutes


def fmt_dt(dt: datetime) -> str:
    return dt.strftime("%H:%M:%S %d/%m/%Y")


def run_hf_keys(run_number: int) -> None:
    now = datetime.now()
    header = f"==={fmt_dt(now)}, run {run_number}==="
    print(header, flush=True)

    proc = subprocess.Popen(
        ["node", str(HF_KEYS_JS)],
        cwd=str(SCRIPT_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    for line in proc.stdout:
        print(line, end="", flush=True)

    proc.wait()

    if run_number < RUNS_PER_CYCLE:
        print(f"===end of run {run_number}===\n", flush=True)
    else:
        next_run = datetime.now() + timedelta(minutes=90)
        print(
            f"===End of run {run_number}. Next run at {fmt_dt(next_run)}===\n",
            flush=True,
        )


def main():
    print(f"Scheduler started — {fmt_dt(datetime.now())}", flush=True)
    print(f"Cycle: {RUNS_PER_CYCLE} runs × {INTERVAL_SECONDS // 60}min intervals\n", flush=True)

    while True:
        cycle_start = time.monotonic()

        for run in range(1, RUNS_PER_CYCLE + 1):
            run_start = time.monotonic()

            run_hf_keys(run)

            if run < RUNS_PER_CYCLE:
                elapsed = time.monotonic() - run_start
                sleep_for = max(0, INTERVAL_SECONDS - elapsed)
                next_run_time = datetime.now() + timedelta(seconds=sleep_for)
                print(f"Next run at {fmt_dt(next_run_time)}\n", flush=True)
                time.sleep(sleep_for)

        # Wait out the remainder of the 90-min window before next cycle
        cycle_elapsed = time.monotonic() - cycle_start
        cycle_remainder = max(0, (90 * 60) - cycle_elapsed)
        if cycle_remainder > 0:
            next_cycle = datetime.now() + timedelta(seconds=cycle_remainder)
            print(f"Cycle complete. Next cycle at {fmt_dt(next_cycle)}\n", flush=True)
            time.sleep(cycle_remainder)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nScheduler stopped.", flush=True)
        sys.exit(0)
