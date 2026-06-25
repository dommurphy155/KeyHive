#!/usr/bin/env python3
"""
count_keys.py — Report how many Hugging Face keys are saved and estimate the
rough token-buying value of the pool.

Reads data/keys.txt (the file hf_keys.js appends each new token to), counts the
non-blank lines, and prints a value estimate. The "value" is a back-of-envelope
figure: each HF key is treated as worth a fixed dollar amount, and that total is
divided by representative per-1M-token prices for frontier / mid-tier / cheap
models to show how much output that pool could buy.

These are rough estimates, not accounting — real usage depends on the provider,
model, caching, reasoning tokens, and inference backend. The last-count cache
(data/.last_key_count) only exists so the report can show a delta since the
previous run.
"""

from pathlib import Path
import subprocess
import sys

# The key counter reads the canonical output file used by hf_keys.js and turns
# it into a rough value estimate for reporting purposes.
ROOT_DIR = Path(__file__).resolve().parents[1]
KEYS_FILE = ROOT_DIR / "data" / "keys.txt"
LAST_COUNT_FILE = ROOT_DIR / "data" / ".last_key_count"

# Assumed dollar value credited to each Hugging Face key. This is a rough
# stand-in for the monthly inference credits a fresh key unlocks, not a real
# price — it only exists to turn a key count into a comparable number.
COST_PER_KEY = 0.10

# Representative pricing per 1M output tokens, used to convert the pool's total
# value into an estimated token capacity for three model tiers.
FRONTIER_MODEL_COST = 75.00
MID_TIER_MODEL_COST = 15.00
CHEAP_MODEL_COST = 1.10


def format_tokens(num):
    if num >= 1_000_000:
        return f"{num / 1_000_000:.2f}M"
    if num >= 1_000:
        return f"{num / 1_000:.2f}K"
    return str(int(num))


def get_previous_count():
    if not LAST_COUNT_FILE.exists():
        return None

    try:
        return int(LAST_COUNT_FILE.read_text().strip())
    except:
        return None


def save_current_count(count):
    LAST_COUNT_FILE.write_text(str(count))


def main():
    # The file count is the source of truth; the last-count cache only exists to
    # show how the key pool changed since the previous report.
    if not KEYS_FILE.exists():
        print(f"\n[-] File not found: {KEYS_FILE}\n")
        sys.exit(1)

    result = subprocess.run(
        ["wc", "-l", str(KEYS_FILE)],
        capture_output=True,
        text=True,
        check=True
    )

    key_count = int(result.stdout.strip().split()[0])

    previous_count = get_previous_count()

    if previous_count is None:
        difference = 0
    else:
        difference = key_count - previous_count

    save_current_count(key_count)

    total_value = key_count * COST_PER_KEY

    frontier_tokens = (total_value / FRONTIER_MODEL_COST) * 1_000_000
    mid_tokens = (total_value / MID_TIER_MODEL_COST) * 1_000_000
    cheap_tokens = (total_value / CHEAP_MODEL_COST) * 1_000_000

    if difference > 0:
        diff_display = f"+{difference}"
    elif difference < 0:
        diff_display = str(difference)
    else:
        diff_display = "0"

    print("\n" + "=" * 60)
    print("        HUGGING FACE API KEY VALUE ESTIMATOR")
    print("=" * 60)

    print(f"\n🔑  Valid API Keys        : {key_count:,}")
    print(f"➕  Since Last Check      : {diff_display}")
    print(f"💰  Estimated Value       : ${total_value:,.2f}")

    print("\n📊  Estimated Token Capacity")
    print("-" * 60)

    print(
        f"🧠  Frontier Models       : "
        f"{format_tokens(frontier_tokens)} output tokens"
    )

    print(
        f"⚡  Mid-Tier Models       : "
        f"{format_tokens(mid_tokens)} output tokens"
    )

    print(
        f"🚀  Cheap/Open Models     : "
        f"{format_tokens(cheap_tokens)} output tokens"
    )

    print("\nℹ️  Estimates are based on current LLM API pricing.")
    print("    Real usage varies by provider, model, caching,")
    print("    reasoning tokens, and inference backend.\n")

    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
