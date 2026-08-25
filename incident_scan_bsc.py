#!/usr/bin/env python3
"""
One-off forensic scan: did the 25 Aug 2026 incident have a BNB Chain leg?

WHY THIS EXISTS
The incident had four confirmed legs (Ethereum, Algorand, Stellar, Realio native).
BNB Chain could not be checked from public RPCs: every free endpoint either caps
eth_getLogs, disables it, or rate-limits before the ~84,000-block window is covered.
Worse, a capped or throttled endpoint returns an EMPTY result rather than an error,
so a naive scan reports "nothing happened" when it has actually seen nothing at all.
That is a false negative, and it is the same failure mode that hid the native and
Ethereum legs behind clean-looking supply totals.

METHOD
eth_getLogs against an archive endpoint, walking the window in chunks and halving
the chunk on any error or near-cap result count. This is the same approach that
worked for the July 2026 BSC mint/burn audit (RIO-bsc-mint-burn-audit.py).

Note: Alchemy does NOT serve alchemy_getAssetTransfers on BNB Chain, only on its
Ethereum-family networks. An earlier version of this script used it and the run
failed. Plain eth_getLogs is the portable call and works on any archive RPC.

COVERAGE IS TRACKED, NOT ASSUMED
Every block in the window is either covered by a successful query or recorded in
`skipped`. If anything is skipped the output is marked complete=false and the
script exits non-zero, so a partial scan can never be mistaken for a clean result.

WHAT IT LOOKS FOR
A sweep is a many-to-one pattern: one recipient receiving from a large number of
distinct senders in a short window, where that recipient has no comparable history.
Recipients are ranked by DISTINCT SENDER COUNT, which is the signal. Ranking by
volume just surfaces DEX pools and exchange hot wallets.

USAGE
  export ALCHEMY_BNB_URL="https://bnb-mainnet.g.alchemy.com/v2/<key>"   # or any archive BSC RPC
  python3 incident_scan_bsc.py
The URL embeds the key, so it is read from the environment and never printed.
"""
import json, os, sys, time, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

RIO_BSC = "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "incident-scan-bsc.json")

# 25 Aug 2026, widened either side of the known legs (earliest 03:46 UTC on
# Ethereum, latest 10:15 UTC on native) so a BNB leg outside that band still lands.
WINDOW_START = datetime(2026, 8, 25, 0, 0, tzinfo=timezone.utc)
WINDOW_END   = datetime(2026, 8, 25, 14, 0, tzinfo=timezone.utc)

URL = (os.environ.get("ALCHEMY_BNB_URL") or os.environ.get("RPC_URL") or "").strip()
if not URL:
    sys.exit("Set ALCHEMY_BNB_URL (or RPC_URL) to an archive BSC RPC. In CI it is a repo secret.")

_id = 0


def rpc(method, params, tries=4):
    """Return the raw JSON-RPC body. Transport failures raise; JSON-RPC errors are
    returned so the caller can decide to shrink the window and retry."""
    global _id
    _id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": method, "params": params}).encode()
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                URL, data=body,
                headers={"Content-Type": "application/json",
                         "User-Agent": "realiostats-incident-scan/1.1"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except Exception as e:                          # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{method} transport failure after {tries} attempts: {last}")


def result(method, params):
    d = rpc(method, params)
    if "error" in d:
        raise RuntimeError(f"{method}: {str(d['error'])[:160]}")
    return d["result"]


def block_ts(n):
    return int(result("eth_getBlockByNumber", [hex(n), False])["timestamp"], 16)


def block_at(target, lo, hi):
    """Binary search for the first block at or after `target`."""
    while lo < hi:
        mid = (lo + hi) // 2
        if block_ts(mid) < target:
            lo = mid + 1
        else:
            hi = mid
    return lo


def main():
    latest = int(result("eth_blockNumber", []), 16)
    lt = block_ts(latest)
    bt = (lt - block_ts(latest - 20000)) / 20000
    lo_guess = max(1, int(latest - (lt - WINDOW_START.timestamp()) / bt) - 20000)
    b0 = block_at(int(WINDOW_START.timestamp()), lo_guess, latest)
    b1 = block_at(int(WINDOW_END.timestamp()), b0, latest)
    total_blocks = b1 - b0 + 1
    print(f"block time ~{bt:.3f}s   window {b0:,}..{b1:,}  ({total_blocks:,} blocks)", flush=True)

    logs, skipped, covered = [], [], 0
    window, cur = 20000, b0
    while cur <= b1:
        hi = min(cur + window - 1, b1)
        d = rpc("eth_getLogs", [{"address": RIO_BSC, "topics": [TRANSFER],
                                 "fromBlock": hex(cur), "toBlock": hex(hi)}])
        if "error" in d:
            if hi > cur:
                window = max(1, (hi - cur + 1) // 2)
                continue
            skipped.append(cur)
            print(f"  ! block {cur} skipped: {str(d['error'])[:90]}", flush=True)
            cur += 1
            continue
        res = d.get("result", [])
        if len(res) >= 9000 and hi > cur:      # near a provider result cap: shrink
            window = max(1, (hi - cur + 1) // 2)
            continue
        logs += res
        covered += hi - cur + 1
        pct = 100 * covered / total_blocks
        print(f"  {pct:5.1f}%  to block {hi:,}  events {len(logs):,}", flush=True)
        cur = hi + 1

    recv = defaultdict(lambda: {"rio": 0.0, "senders": set(), "n": 0,
                                "first_block": None, "last_block": None})
    for lg in logs:
        try:
            frm = "0x" + lg["topics"][1][-40:]
            to = "0x" + lg["topics"][2][-40:]
            val = int(lg["data"], 16) / 1e18
            bn = int(lg["blockNumber"], 16)
        except Exception:                                # noqa: BLE001
            continue
        r = recv[to]
        r["rio"] += val
        r["senders"].add(frm)
        r["n"] += 1
        r["first_block"] = bn if r["first_block"] is None else min(r["first_block"], bn)
        r["last_block"] = bn if r["last_block"] is None else max(r["last_block"], bn)

    ranked = sorted(recv.items(), key=lambda kv: -len(kv[1]["senders"]))[:25]
    complete = not skipped and covered == total_blocks
    print(f"\ncoverage: {covered:,}/{total_blocks:,} blocks, {len(skipped)} skipped")
    print(f"transfer events: {len(logs):,}\n")
    print(f"{'recipient':44s} {'RIO in':>16s} {'senders':>8s} {'xfers':>7s}")
    for a, d in ranked:
        print(f"{a:44s} {d['rio']:>16,.2f} {len(d['senders']):>8} {d['n']:>7}")
    print("\nA SWEEP looks like: one recipient, many distinct senders, tight window, no history.")
    print("Ordinary DEX and exchange flow has few senders, or runs every day.")

    out = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "chain": "bnb", "contract": RIO_BSC, "method": "eth_getLogs",
        "window_utc": [WINDOW_START.isoformat(), WINDOW_END.isoformat()],
        "blocks": [b0, b1], "blocks_total": total_blocks, "blocks_covered": covered,
        "blocks_skipped": skipped, "transfer_events": len(logs),
        "complete": complete,
        "top_recipients_by_distinct_senders": [
            {"address": a, "rio_in": round(d["rio"], 4),
             "distinct_senders": len(d["senders"]), "transfers": d["n"],
             "first_block": d["first_block"], "last_block": d["last_block"]}
            for a, d in ranked],
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, indent=2)
    print(f"\nwrote {OUT}  (complete={complete})")
    if not complete:
        sys.exit("INCOMPLETE COVERAGE: refusing to report this as a clean result.")


if __name__ == "__main__":
    main()
