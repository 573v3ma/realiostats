#!/usr/bin/env python3
"""
One-off forensic scan: did the 25 Aug 2026 incident have a BNB Chain leg?

WHY THIS EXISTS
The incident had four confirmed legs (Ethereum, Algorand, Stellar, Realio native).
BNB Chain could not be checked from public RPCs: every free endpoint either caps
eth_getLogs, disables it, or rate-limits before the ~84,000-block window is covered.
Worse, a capped endpoint returns an EMPTY result rather than an error, so a naive
scan reports "nothing happened" when it has actually seen nothing at all. That is a
false negative, and it is the same failure mode that hid the native and Ethereum
legs behind clean-looking supply totals.

Alchemy's alchemy_getAssetTransfers is not range-limited and pages deterministically,
so it can cover the whole window and, crucially, FAIL LOUDLY if it cannot.

WHAT IT LOOKS FOR
A sweep is a many-to-one pattern: one recipient receiving from a large number of
distinct senders in a short window, where that recipient has no comparable history.
This prints the top recipients by DISTINCT SENDER COUNT, which is the signal, rather
than by volume, which is dominated by ordinary DEX and exchange flow.

USAGE
  export ALCHEMY_BNB_URL="https://bnb-mainnet.g.alchemy.com/v2/<key>"
  python3 incident_scan_bsc.py            # writes incident-scan-bsc.json

The URL embeds the API key, so it is read from the environment and never printed.
In CI it comes from the ALCHEMY_BNB_URL GitHub Actions secret.
"""
import json, os, sys, time, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

RIO_BSC = "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "incident-scan-bsc.json")

# 25 Aug 2026. Widened either side of the known legs (earliest 03:46 UTC on
# Ethereum, latest 10:15 UTC on native) so a BNB leg outside that band still lands.
WINDOW_START = datetime(2026, 8, 25, 0, 0, tzinfo=timezone.utc)
WINDOW_END   = datetime(2026, 8, 25, 14, 0, tzinfo=timezone.utc)

URL = os.environ.get("ALCHEMY_BNB_URL", "").strip()
if not URL:
    sys.exit("ALCHEMY_BNB_URL is not set. In CI this is a repo secret; locally, export it.")


def rpc(method, params, tries=4):
    """Raise on failure. Never swallow an error into an empty result."""
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                URL,
                data=json.dumps({"jsonrpc": "2.0", "id": 1,
                                 "method": method, "params": params}).encode(),
                headers={"Content-Type": "application/json",
                         "User-Agent": "realiostats-incident-scan/1.0"})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = json.load(r)
            if "result" in body:
                return body["result"]
            last = RuntimeError(str(body.get("error"))[:200])
        except Exception as e:                       # noqa: BLE001
            last = e
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{method} failed after {tries} attempts: {last}")


def block_at(ts, latest, latest_ts, block_time):
    """Walk to the first block at or after ts. Cheap: a few probes."""
    n = max(1, int(latest - (latest_ts - ts) / block_time))
    for _ in range(40):
        t = int(rpc("eth_getBlockByNumber", [hex(n), False])["timestamp"], 16)
        drift = ts - t
        if abs(drift) <= block_time * 2:
            return n
        n = max(1, min(latest, n + int(drift / block_time)))
    return n


def main():
    latest = int(rpc("eth_blockNumber", []), 16)
    lt = int(rpc("eth_getBlockByNumber", [hex(latest), False])["timestamp"], 16)
    ref = int(rpc("eth_getBlockByNumber", [hex(latest - 20000), False])["timestamp"], 16)
    bt = (lt - ref) / 20000
    b0 = block_at(WINDOW_START.timestamp(), latest, lt, bt)
    b1 = block_at(WINDOW_END.timestamp(), latest, lt, bt)
    b1 = min(b1, latest)
    print(f"block time ~{bt:.3f}s   scanning {b0}..{b1}  ({b1 - b0:,} blocks)")

    transfers, page, pages = [], None, 0
    while True:
        p = {"fromBlock": hex(b0), "toBlock": hex(b1),
             "contractAddresses": [RIO_BSC], "category": ["erc20"],
             "withMetadata": True, "excludeZeroValue": False, "maxCount": "0x3e8"}
        if page:
            p["pageKey"] = page
        res = rpc("alchemy_getAssetTransfers", [p])
        transfers += res.get("transfers", [])
        pages += 1
        page = res.get("pageKey")
        print(f"  page {pages}: {len(transfers):,} transfers so far")
        if not page:
            break
        if pages > 400:
            raise RuntimeError("pagination cap hit; window may be wrong")

    recv = defaultdict(lambda: {"rio": 0.0, "senders": set(), "n": 0, "first": None, "last": None})
    for t in transfers:
        to = (t.get("to") or "").lower()
        frm = (t.get("from") or "").lower()
        val = float(t.get("value") or 0)
        ts = (t.get("metadata") or {}).get("blockTimestamp")
        r = recv[to]
        r["rio"] += val
        r["senders"].add(frm)
        r["n"] += 1
        if ts:
            r["first"] = ts if r["first"] is None else min(r["first"], ts)
            r["last"] = ts if r["last"] is None else max(r["last"], ts)

    ranked = sorted(recv.items(), key=lambda kv: -len(kv[1]["senders"]))[:25]
    print(f"\ntotal transfers in window: {len(transfers):,}")
    print(f"{'recipient':44s} {'RIO in':>16s} {'senders':>8s} {'xfers':>7s}")
    for a, d in ranked:
        print(f"{a:44s} {d['rio']:>16,.2f} {len(d['senders']):>8} {d['n']:>7}")
    print("\nA SWEEP looks like: one recipient, many distinct senders, tight time window,")
    print("and no comparable history. Ordinary DEX/exchange flow has few senders or runs daily.")

    out = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "chain": "bnb", "contract": RIO_BSC,
        "window_utc": [WINDOW_START.isoformat(), WINDOW_END.isoformat()],
        "blocks": [b0, b1], "pages": pages, "transfers": len(transfers),
        "complete": True,
        "top_recipients_by_distinct_senders": [
            {"address": a, "rio_in": round(d["rio"], 4), "distinct_senders": len(d["senders"]),
             "transfers": d["n"], "first_seen": d["first"], "last_seen": d["last"]}
            for a, d in ranked],
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, indent=2)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
