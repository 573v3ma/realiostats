#!/usr/bin/env python3
"""
One-off forensic scan: did the 25 Aug 2026 incident have a BNB Chain leg?

WHY THIS EXISTS
The incident had four confirmed legs (Ethereum, Algorand, Stellar, Realio native).
BNB Chain could not be checked from public RPCs: every free endpoint either caps
eth_getLogs, disables it, or rate-limits before the ~84,000-block window is covered.
Worse, a capped or throttled endpoint returns an EMPTY result rather than an error,
so a naive scan reports "nothing happened" when it has actually seen nothing at all.
That false negative is the same failure mode that hid the native and Ethereum legs
behind clean-looking supply totals.

METHOD
eth_getLogs against an archive endpoint, walking the window in chunks and halving
the chunk on any error or near-cap result count. Same approach as the July 2026 BSC
mint/burn audit (research/RIO-bsc-mint-burn-audit.py), which covered ~470k transfers.

Alchemy does NOT serve alchemy_getAssetTransfers on BNB Chain, only on its
Ethereum-family networks. Plain eth_getLogs is the portable call.

DIAGNOSTICS FIRST
Two earlier runs failed inside 30 seconds and CI logs are not readable without auth,
so this version runs a preflight that prints exactly which call fails and what the
node said. Endpoint URLs are never printed: they embed the API key.

COVERAGE IS TRACKED, NOT ASSUMED
Every block is either covered by a successful query or recorded in `blocks_skipped`.
Anything skipped marks the output complete=false and exits non-zero, so a partial
scan can never be mistaken for a clean result.

USAGE
  export ALCHEMY_BNB_URL="https://bnb-mainnet.g.alchemy.com/v2/<key>"   # or any archive BSC RPC
  python3 incident_scan_bsc.py
"""
import json, os, sys, time, urllib.error, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

RIO_BSC = "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "incident-scan-bsc.json")

WINDOW_START = datetime(2026, 8, 25, 0, 0, tzinfo=timezone.utc)
WINDOW_END   = datetime(2026, 8, 25, 14, 0, tzinfo=timezone.utc)

URL = (os.environ.get("ALCHEMY_BNB_URL") or os.environ.get("RPC_URL") or "").strip()
if not URL:
    sys.exit("Set ALCHEMY_BNB_URL (or RPC_URL) to an archive BSC RPC. In CI it is a repo secret.")

# Describe the endpoint without ever revealing it.
_host = URL.split("//")[-1].split("/")[0] if "//" in URL else "?"
print(f"endpoint host: {_host}  (key not shown)", flush=True)

_id = 0


def rpc(method, params, tries=5, quiet=False):
    """Return the JSON-RPC body dict. Transport errors are retried with backoff and,
    if they persist, returned as {'error': ...} so callers can react rather than die."""
    global _id
    _id += 1
    body = json.dumps({"jsonrpc": "2.0", "id": _id, "method": method, "params": params}).encode()
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                URL, data=body,
                headers={"Content-Type": "application/json",
                         "User-Agent": "realiostats-incident-scan/1.2"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode()[:200]
            except Exception:                                   # noqa: BLE001
                pass
            last = f"HTTP {e.code} {detail}"
            if e.code in (429, 503):                            # throttled: back off harder
                time.sleep(4 * (attempt + 1))
                continue
        except Exception as e:                                  # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
        time.sleep(1.5 * (attempt + 1))
    if not quiet:
        print(f"  ! {method} failed after {tries} attempts: {last}", flush=True)
    return {"error": {"message": str(last)}}


def preflight():
    print("\n--- preflight ---", flush=True)
    ok = True
    d = rpc("eth_chainId", [])
    if "result" in d:
        cid = int(d["result"], 16)
        print(f"  eth_chainId        -> {cid} {'(BNB Chain)' if cid == 56 else '(NOT BNB CHAIN)'}", flush=True)
        if cid != 56:
            ok = False
    else:
        print(f"  eth_chainId        -> FAILED {str(d['error'])[:140]}", flush=True); ok = False
    d = rpc("eth_blockNumber", [])
    if "result" in d:
        latest = int(d["result"], 16)
        print(f"  eth_blockNumber    -> {latest:,}", flush=True)
    else:
        print(f"  eth_blockNumber    -> FAILED {str(d['error'])[:140]}", flush=True)
        return False, None
    d = rpc("eth_getLogs", [{"address": RIO_BSC, "topics": [TRANSFER],
                             "fromBlock": hex(latest - 200), "toBlock": hex(latest)}])
    if "result" in d:
        print(f"  eth_getLogs (200b) -> {len(d['result'])} events", flush=True)
    else:
        print(f"  eth_getLogs (200b) -> FAILED {str(d['error'])[:140]}", flush=True); ok = False
    d = rpc("eth_getBlockByNumber", [hex(latest - 100000), False])
    if "result" in d and d["result"]:
        print("  archive depth 100k -> OK", flush=True)
    else:
        print(f"  archive depth 100k -> FAILED {str(d.get('error'))[:140]}", flush=True); ok = False
    print("--- end preflight ---\n", flush=True)
    return ok, latest


def main():
    ok, latest = preflight()
    if not ok or latest is None:
        sys.exit("Preflight failed. The messages above say which call and why.")

    lt = int(rpc("eth_getBlockByNumber", [hex(latest), False])["result"]["timestamp"], 16)
    ref = rpc("eth_getBlockByNumber", [hex(latest - 20000), False])
    bt = (lt - int(ref["result"]["timestamp"], 16)) / 20000 if "result" in ref else 0.75

    # Estimate rather than binary-search: the window is already widened by hours on
    # both sides, so a few hundred blocks of drift changes nothing, and it saves ~35
    # requests that could trip a rate limit before the scan even starts.
    pad = int(1800 / max(bt, 0.05))
    b0 = max(1, int(latest - (lt - WINDOW_START.timestamp()) / max(bt, 0.05)) - pad)
    b1 = min(latest, int(latest - (lt - WINDOW_END.timestamp()) / max(bt, 0.05)) + pad)
    total = b1 - b0 + 1
    print(f"block time ~{bt:.3f}s   window {b0:,}..{b1:,}  ({total:,} blocks, padded)", flush=True)

    logs, skipped, covered = [], [], 0
    window, cur = 10000, b0
    while cur <= b1:
        hi = min(cur + window - 1, b1)
        d = rpc("eth_getLogs", [{"address": RIO_BSC, "topics": [TRANSFER],
                                 "fromBlock": hex(cur), "toBlock": hex(hi)}], quiet=True)
        if "error" in d:
            if hi > cur:
                window = max(1, (hi - cur + 1) // 2)
                continue
            skipped.append(cur)
            print(f"  ! block {cur} skipped: {str(d['error'])[:90]}", flush=True)
            cur += 1
            continue
        res = d.get("result", [])
        if len(res) >= 9000 and hi > cur:
            window = max(1, (hi - cur + 1) // 2)
            continue
        logs += res
        covered += hi - cur + 1
        print(f"  {100*covered/total:5.1f}%  to {hi:,}  events {len(logs):,}", flush=True)
        cur = hi + 1
        time.sleep(0.05)

    recv = defaultdict(lambda: {"rio": 0.0, "senders": set(), "n": 0,
                                "first_block": None, "last_block": None})
    for lg in logs:
        try:
            frm = "0x" + lg["topics"][1][-40:]
            to = "0x" + lg["topics"][2][-40:]
            val = int(lg["data"], 16) / 1e18
            bn = int(lg["blockNumber"], 16)
        except Exception:                                        # noqa: BLE001
            continue
        r = recv[to]
        r["rio"] += val; r["senders"].add(frm); r["n"] += 1
        r["first_block"] = bn if r["first_block"] is None else min(r["first_block"], bn)
        r["last_block"] = bn if r["last_block"] is None else max(r["last_block"], bn)

    ranked = sorted(recv.items(), key=lambda kv: -len(kv[1]["senders"]))[:25]
    complete = not skipped and covered == total
    print(f"\ncoverage {covered:,}/{total:,} blocks, {len(skipped)} skipped")
    print(f"transfer events: {len(logs):,}\n")
    print(f"{'recipient':44s} {'RIO in':>16s} {'senders':>8s} {'xfers':>7s}")
    for a, d in ranked:
        print(f"{a:44s} {d['rio']:>16,.2f} {len(d['senders']):>8} {d['n']:>7}")
    print("\nA SWEEP looks like: one recipient, many distinct senders, tight window, no history.")

    with open(OUT, "w") as fh:
        json.dump({
            "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "chain": "bnb", "contract": RIO_BSC, "method": "eth_getLogs",
            "window_utc": [WINDOW_START.isoformat(), WINDOW_END.isoformat()],
            "blocks": [b0, b1], "blocks_total": total, "blocks_covered": covered,
            "blocks_skipped": skipped, "transfer_events": len(logs), "complete": complete,
            "top_recipients_by_distinct_senders": [
                {"address": a, "rio_in": round(d["rio"], 4),
                 "distinct_senders": len(d["senders"]), "transfers": d["n"],
                 "first_block": d["first_block"], "last_block": d["last_block"]}
                for a, d in ranked],
        }, fh, indent=2)
    print(f"\nwrote {OUT}  (complete={complete})")
    if not complete:
        sys.exit("INCOMPLETE COVERAGE: refusing to report this as a clean result.")


if __name__ == "__main__":
    main()
