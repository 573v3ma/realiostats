#!/usr/bin/env python3
"""
One-off forensic scan: did the 25 Aug 2026 incident have a BNB Chain leg?

ANSWER: yes. 163 accounts, 2,203,982.24 RIO, 04:15:30 to 05:00:58 UTC, all of it
into 0xbe827abf934cf7f4547e3285f100c39bf690a404, the same address that had swept
121 Ethereum accounts an hour earlier. Not one of the 163 BNB addresses appears in
the Ethereum set. Result committed as incident-scan-bsc.json.

WHY THIS TOOK THREE ATTEMPTS

The first check on BNB Chain compared a contract total. A sweep between accounts on
the same chain does not move a contract total by a single token, so it saw nothing
and the page said BNB Chain was unaffected. That is the same false negative that hid
the native chain leg. Aggregates cannot detect same-chain movement. Only logs can.

The second attempt tried to read the logs and could not. Alchemy was unreachable
(degraded service plus a dashboard that would not accept sign-in), Etherscan V2 does
not serve BNB Chain on the free tier, and of sixteen public BSC endpoints tested,
fourteen refused eth_getLogs outright: 403, 429, "limit exceeded", "eth_getLogs is
not supported", or a 50-block ceiling. Several of those refusals arrive as an EMPTY
result rather than an error, which is how a scan reports "nothing happened" having
seen nothing at all.

bsc.rpc.blxrbdn.com serves the query in 5,000-block chunks, with no key. That is the
whole reason this file now works. If it stops working, the fallbacks below are worth
retrying before assuming the window is unreadable; endpoint availability moves around.

COVERAGE IS TRACKED, NOT ASSUMED
Every block is either covered by a successful query or recorded in blocks_skipped.
Anything skipped marks the output complete=false and exits non-zero, so a partial
scan can never be mistaken for a clean result.

USAGE
  python3 incident_scan_bsc.py            # uses the public endpoint, no key needed
  RPC_URL="https://..." python3 incident_scan_bsc.py    # or point it anywhere
"""
import json, os, sys, time, urllib.error, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

RIO_BSC = "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "incident-scan-bsc.json")

# The window actually scanned, published on the incident page so the count can be
# reproduced exactly rather than approximately. 25 Aug 2026, roughly 00:00 to 14:00 UTC.
BLOCK_FROM, BLOCK_TO = 117_900_109, 118_012_072

# Endpoints that were tested on 25 Aug 2026. Only the first one served eth_getLogs.
# The others are kept because which of these works changes week to week.
ENDPOINTS = [
    os.environ.get("RPC_URL") or os.environ.get("ALCHEMY_BNB_URL") or "https://bsc.rpc.blxrbdn.com",
    "https://bsc-mainnet.public.blastapi.io",
    "https://bsc-rpc.publicnode.com",
]
CHUNK = 4900          # blxrbdn caps eth_getLogs at 5,000 blocks
NEAR_CAP = 9000       # a result this large may be truncated, so halve and retry


def get_logs(url, lo, hi, tries=4):
    """Return the log list, or raise. Never returns [] to mean failure."""
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
                                 "params": [{"address": RIO_BSC, "topics": [TRANSFER],
                                             "fromBlock": hex(lo), "toBlock": hex(hi)}]}).encode(),
                headers={"Content-Type": "application/json", "User-Agent": "realiostats-incident-scan/2.0"})
            with urllib.request.urlopen(req, timeout=45) as r:
                body = json.load(r)
            if "result" in body:
                return body["result"]
            last = str(body.get("error", {}).get("message"))[:90]
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
        except Exception as e:                                   # noqa: BLE001
            last = type(e).__name__
        time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(last or "unknown failure")


def pick_endpoint():
    """Find an endpoint that will actually serve a log query, and say so out loud."""
    for url in ENDPOINTS:
        host = url.split("//")[-1].split("/")[0]
        try:
            get_logs(url, BLOCK_FROM, BLOCK_FROM + 199, tries=2)
            print(f"endpoint: {host}  (serves eth_getLogs)", flush=True)
            return url
        except Exception as e:                                   # noqa: BLE001
            print(f"  {host} refused: {e}", flush=True)
    sys.exit("No endpoint would serve eth_getLogs. Refusing to report an empty window as clean.")


def main():
    url = pick_endpoint()
    total = BLOCK_TO - BLOCK_FROM + 1
    logs, skipped, covered, cur, chunk = [], [], 0, BLOCK_FROM, CHUNK

    while cur <= BLOCK_TO:
        hi = min(cur + chunk - 1, BLOCK_TO)
        try:
            res = get_logs(url, cur, hi)
        except Exception as e:                                   # noqa: BLE001
            if hi > cur and chunk > 200:
                chunk = max(200, chunk // 2)
                continue
            skipped.append([cur, hi])
            print(f"  ! blocks {cur:,}-{hi:,} skipped: {e}", flush=True)
            cur = hi + 1
            continue
        if len(res) >= NEAR_CAP and hi > cur:
            chunk = max(200, chunk // 2)
            continue
        logs += res
        covered += hi - cur + 1
        cur = hi + 1
        print(f"  {100 * covered / total:5.1f}%  through {hi:,}  events {len(logs):,}", flush=True)

    recv = defaultdict(lambda: {"rio": 0.0, "senders": set(), "n": 0, "first": None, "last": None})
    for lg in logs:
        try:
            frm, to = "0x" + lg["topics"][1][-40:], "0x" + lg["topics"][2][-40:]
            val, bn = int(lg["data"], 16) / 1e18, int(lg["blockNumber"], 16)
        except Exception:                                        # noqa: BLE001
            continue
        r = recv[to]
        r["rio"] += val; r["senders"].add(frm); r["n"] += 1
        r["first"] = bn if r["first"] is None else min(r["first"], bn)
        r["last"] = bn if r["last"] is None else max(r["last"], bn)

    ranked = sorted(recv.items(), key=lambda kv: -len(kv[1]["senders"]))[:25]
    complete = not skipped and covered == total

    print(f"\ncoverage {covered:,}/{total:,} blocks, {len(skipped)} skipped")
    print(f"transfer events: {len(logs):,}\n")
    print(f"{'recipient':44s} {'RIO in':>16s} {'senders':>8s} {'xfers':>7s}")
    for a, d in ranked:
        print(f"{a:44s} {d['rio']:>16,.2f} {len(d['senders']):>8} {d['n']:>7}")
    print("\nA SWEEP looks like: one recipient, many distinct senders, one transfer each,")
    print("a tight window, and no prior history. Normal trading looks like many transfers")
    print("per sender spread across the whole window. The difference is easy to see above.")

    # Describe the strongest sweep candidate from the data rather than asserting it,
    # and list the accounts it emptied so holders can search for their own address.
    finding = {}
    if ranked:
        top_addr, top = ranked[0]
        sizes = sorted(int(l["data"], 16) / 1e18 for l in logs
                       if "0x" + l["topics"][2][-40:] == top_addr)
        victims = sorted({"0x" + l["topics"][1][-40:] for l in logs
                          if "0x" + l["topics"][2][-40:] == top_addr})
        finding = {
            "collector": top_addr,
            "accounts_swept": len(top["senders"]),
            "transfers": top["n"],
            "transfers_per_account": round(top["n"] / max(len(top["senders"]), 1), 3),
            "rio_taken": round(top["rio"], 4),
            "first_block": top["first"], "last_block": top["last"],
            "median_transfer_rio": round(sizes[len(sizes) // 2], 2) if sizes else None,
            "max_transfer_rio": round(sizes[-1], 2) if sizes else None,
            "transfers_over_100k": sum(1 for v in sizes if v > 1e5),
        }
    else:
        victims = []

    with open(OUT, "w") as fh:
        json.dump({
            "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "chain": "bnb", "chain_id": 56, "contract": RIO_BSC, "method": "eth_getLogs",
            "endpoint_host": url.split("//")[-1].split("/")[0], "chunk_blocks": CHUNK,
            "blocks": [BLOCK_FROM, BLOCK_TO], "blocks_total": total,
            "blocks_covered": covered, "blocks_skipped": skipped,
            "transfer_events": len(logs), "complete": complete,
            "finding": finding,
            "top_recipients_by_distinct_senders": [
                {"address": a, "rio_in": round(d["rio"], 4),
                 "distinct_senders": len(d["senders"]), "transfers": d["n"],
                 "first_block": d["first"], "last_block": d["last"]} for a, d in ranked],
            "swept_accounts": victims,
        }, fh, indent=2)
    print(f"\nwrote {OUT}  (complete={complete})")
    if not complete:
        sys.exit("INCOMPLETE COVERAGE: refusing to report this as a clean result.")


if __name__ == "__main__":
    main()
