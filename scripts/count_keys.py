#!/usr/bin/env python3
"""
count_keys.py — Report how many Hugging Face keys are saved and estimate the
rough token-buying value of the proxy.

Reads data/keys.txt (the file hf_keys.js appends each new token to), counts the
non-blank lines, and prints a value estimate. The "value" is a back-of-envelope
figure: each HF key is treated as worth a fixed dollar amount, and that total is
divided by representative per-1M-token prices for frontier / mid-tier / cheap
models to show how much output that pool could buy.

These are rough estimates, not accounting — real usage depends on the provider,
model, caching, reasoning tokens, and inference backend. The last-count cache
(data/.last_key_count) only exists so the report can show a delta since the
previous run.

If proxy_stats.json exists, the report also shows real-world capacity estimates
derived from actual proxy usage data.
"""

from pathlib import Path
import json
import subprocess
import sys

# The key counter reads the canonical output file used by hf_keys.js and turns
# it into a rough value estimate for reporting purposes.
ROOT_DIR = Path(__file__).resolve().parents[1]
KEYS_FILE = ROOT_DIR / "data" / "keys.txt"
LAST_COUNT_FILE = ROOT_DIR / "data" / ".last_key_count"
PROXY_STATS_FILE = ROOT_DIR / "data" / "proxy_stats.json"

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


def load_proxy_stats():
    """Load proxy statistics for real-world capacity estimation."""
    try:
        raw = PROXY_STATS_FILE.read_text()
        data = json.loads(raw)
        all_time = data.get("all_time", {})
        restart = data.get("restart", {})

        # Use all-time average if available, fall back to restart
        if all_time.get("requests", 0) > 0:
            avg_tokens = all_time["total_tokens"] / all_time["requests"]
            data_source = "all-time average"
        elif restart.get("requests", 0) > 0:
            avg_tokens = restart["total_tokens"] / restart["requests"]
            data_source = "restart average"
        else:
            avg_tokens = None
            data_source = None

        return {
            "total_tokens": all_time.get("total_tokens", 0),
            "requests": all_time.get("requests", 0),
            "avg_tokens": avg_tokens,
            "data_source": data_source,
            "provider_hf": all_time.get("provider_hf", 0) + restart.get("provider_hf", 0),
            "provider_nvidia": all_time.get("provider_nvidia", 0) + restart.get("provider_nvidia", 0),
            "models": {**all_time.get("models", {}), **restart.get("models", {})},
        }
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


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

    print(f"\n  Valid API Keys        : {key_count:,}")
    print(f"  Since Last Check      : {diff_display}")
    print(f"  Estimated Value       : ${total_value:,.2f}")

    print("\n  Estimated Token Capacity")
    print("-" * 60)

    print(
        f"  Frontier Models       : "
        f"{format_tokens(frontier_tokens)} output tokens"
    )

    print(
        f"  Mid-Tier Models       : "
        f"{format_tokens(mid_tokens)} output tokens"
    )

    print(
        f"  Cheap/Open Models     : "
        f"{format_tokens(cheap_tokens)} output tokens"
    )

    # Real-world capacity from proxy stats
    ps = load_proxy_stats()
    if ps and ps["avg_tokens"] is not None:
        print("\n  Real-World Capacity Estimates (proxy data)")
        print("-" * 60)
        print(f"  Data source: {ps['data_source']}")
        print(f"  Requests processed: {ps['requests']:,}")
        print(f"  Avg tokens/req: {ps['avg_tokens']:,.0f}")

        # Estimate remaining capacity based on real usage
        # Total value / cost_per_key = total credit, divided by avg cost per request
        avg_cost_per_req = (ps["avg_tokens"] / 1_000_000) * MID_TIER_MODEL_COST
        if avg_cost_per_req > 0:
            remaining_requests = total_value / avg_cost_per_req
            remaining_tokens = remaining_requests * ps["avg_tokens"]
            print(f"\n  Estimated requests remaining: {format_tokens(remaining_requests):>12}")
            print(f"  Estimated output remaining:   {format_tokens(remaining_tokens):>12}")

        # Provider breakdown
        total_provider = ps["provider_hf"] + ps["provider_nvidia"]
        if total_provider > 0:
            hf_pct = ps["provider_hf"] / total_provider * 100
            nv_pct = ps["provider_nvidia"] / total_provider * 100
            print(f"\n  Provider usage:")
            print(f"    Hugging Face: {hf_pct:.0f}% ({ps['provider_hf']:,} requests)")
            print(f"    NVIDIA:       {nv_pct:.0f}% ({ps['provider_nvidia']:,} requests)")

        # Top models
        models = ps.get("models", {})
        if models:
            top = sorted(models, key=models.get, reverse=True)[:5]
            print(f"\n  Top models:")
            for m in top:
                print(f"    {m:<45} {models[m]:,} requests")
    else:
        print("\n  Real-world capacity estimates will appear after")
        print("  the proxy processes its first requests.")

    print("\n  Estimates are based on current LLM API pricing.")
    print("  Real usage varies by provider, model, caching,")
    print("  reasoning tokens, and inference backend.\n")

    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
