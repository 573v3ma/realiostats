#!/usr/bin/env python3
"""
EVM holder counts for realiostats (holder-base, Phase 2).

Reconstructs every address's RIO balance on BNB Chain and Ethereum from the full
ERC-20 Transfer history via Alchemy's getAssetTransfers, nets it per address, and
counts holders at >= 100 / 1,000 / 10,000 RIO. Writes holders-evm.json, which the
site reads for the BNB Chain and Ethereum rows of the holder-base table.

This is HEAVY (BNB alone is ~470k transfers, a few hundred paginated calls) so it
is NOT part of the daily keyless supply pipeline. Run it on its own schedule;
weekly is plenty (see .github/workflows/evm-holders.yml).

Requires an Alchemy endpoint per chain, passed as env vars:
  ALCHEMY_BNB_URL = https://bnb-mainnet.g.alchemy.com/v2/YOUR_KEY
  ALCHEMY_ETH_URL = https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY   (Ethereum must
                    be enabled on the Alchemy app, or use a separate ETH key)

A chain whose URL is unset, or whose run errors, is skipped and its previous
value in holders-evm.json is kept. The BNB count validates against BscScan's
holder number (24,839 on 2026-08-03).
"""
import json, os, sys, time, urllib.request
from datetime import datetime, timezone

CONTRACT = "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"
ZERO = "0x0000000000000000000000000000000000000000"
DEC = 10**18
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "holders-evm.json")
THRESHOLDS = [("gte_100", 100), ("gte_1k", 1000), ("gte_10k", 10000)]

def rpc(url, method, params):
    for a in range(6):
        try:
            body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=60))
            if "error" in d:
                if any(x in str(d["error"]).lower() for x in ("rate", "limit", "many")):
                    time.sleep(1.5); continue
                raise RuntimeError(d["error"])
            return d
        except Exception:
            if a == 5:
                raise
            time.sleep(1.5)

def count_holders(url):
    bal, pk = {}, None
    while True:
        p = {"fromBlock": "0x0", "toBlock": "latest", "contractAddresses": [CONTRACT],
             "category": ["erc20"], "excludeZeroValue": False, "maxCount": "0x3e8", "order": "asc"}
        if pk:
            p["pageKey"] = pk
        res = rpc(url, "alchemy_getAssetTransfers", [p])["result"]
        for t in res["transfers"]:
            rv = t.get("rawContract", {}).get("value")
            if not rv:
                continue
            v = int(rv, 16)
            f, to = t.get("from"), t.get("to")
            if f:  bal[f]  = bal.get(f, 0) - v
            if to: bal[to] = bal.get(to, 0) + v
        pk = res.get("pageKey")
        if not pk:
            break
    out = {"total": 0, "gte_100": 0, "gte_1k": 0, "gte_10k": 0}
    for a, b in bal.items():
        if a == ZERO or b <= 0:
            continue
        out["total"] += 1
        amt = b / DEC
        for k, thr in THRESHOLDS:
            if amt >= thr:
                out[k] += 1
    return out

def main():
    try:
        chains = (json.load(open(OUT)).get("chains") or {})
    except Exception:
        chains = {"bnb": None, "ethereum": None}
    for key, env in (("bnb", "ALCHEMY_BNB_URL"), ("ethereum", "ALCHEMY_ETH_URL")):
        url = os.environ.get(env, "").strip()
        if not url:
            print(f"{key}: {env} unset, keeping previous value", file=sys.stderr)
            continue
        try:
            chains[key] = count_holders(url)
            print(f"{key}: {chains[key]}")
        except Exception as e:
            print(f"{key}: FAILED ({type(e).__name__}: {e}), keeping previous", file=sys.stderr)
    out = {
        "as_of": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source": "Reconstructed from the full ERC-20 Transfer history via Alchemy getAssetTransfers, netted per address.",
        "chains": chains,
    }
    json.dump(out, open(OUT, "w"), indent=2)
    print("wrote", OUT)

if __name__ == "__main__":
    main()
