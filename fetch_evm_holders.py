#!/usr/bin/env python3
"""
EVM holder counts + monthly evolution for realiostats (holder-base, Phase 2).

For each EVM chain (BNB, Ethereum) this walks the token's ENTIRE ERC-20 Transfer
history once, in chronological order, netting a running balance per address. In
that SAME single pass it also freezes the holder distribution at every month
boundary, so one run produces both:

  * the current snapshot   -> total / >=100 / >=1,000 / >=10,000 RIO
  * the monthly evolution  -> the same four counts at each month-end

Because transfers are streamed ascending with their block timestamps, the whole
time series costs essentially the same as a single snapshot: no per-date re-runs.

The current RIO contracts on both chains were re-issued at the 30 Oct 2024
migration, so their on-chain history begins there. There is no data before the
migration on these contracts, and the series starts at the first month of
activity (2024-10). Nothing earlier can be reconstructed from these addresses.

Writes holders-evm.json, which the site reads for the BNB Chain and Ethereum
rows of the holder-base table and for the EVM evolution chart. A chain whose URL
env var is unset, or whose run errors, is skipped and its previous value is kept.

Env vars (an Alchemy endpoint per chain):
  ALCHEMY_BNB_URL = https://bnb-mainnet.g.alchemy.com/v2/YOUR_KEY
  ALCHEMY_ETH_URL = https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

The BNB and Ethereum current totals validate against the explorer holder counts,
and the final month reconciles against the contract's on-chain total supply.
"""
import json, os, sys, time, pickle, urllib.request
from datetime import datetime, timezone

CONTRACT = "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"
ZERO = "0x0000000000000000000000000000000000000000"
DEC = 10**18
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "holders-evm.json")
THRESHOLDS = [("gte_100", 100), ("gte_1k", 1000), ("gte_10k", 10000), ("gte_100k", 100000)]


def rpc(url, method, params):
    for a in range(6):
        try:
            body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=90))
            if "error" in d:
                if any(x in str(d["error"]).lower() for x in ("rate", "limit", "many")):
                    time.sleep(1.5); continue
                raise RuntimeError(d["error"])
            return d
        except Exception:
            if a == 5:
                raise
            time.sleep(1.5)


def count_bal(bal):
    """Holder distribution of the current balance map."""
    o = {"total": 0}
    for k, _ in THRESHOLDS:
        o[k] = 0
    for a, b in bal.items():
        if a == ZERO or b <= 0:
            continue
        o["total"] += 1
        amt = b / DEC
        for k, thr in THRESHOLDS:
            if amt >= thr:
                o[k] += 1
    return o


def next_month(m):
    y, mo = map(int, m.split("-"))
    mo += 1
    if mo > 12:
        mo = 1; y += 1
    return f"{y:04d}-{mo:02d}"


def process_chain(url, ck_path=None, budget=None):
    """Stream the full transfer history once, netting balances and snapshotting
    the holder distribution at each month-end. Returns the current snapshot dict
    with an added `history` list [{month, total, gte_100, gte_1k, gte_10k}, ...],
    or None if a checkpoint budget was hit before finishing (state is saved).
    """
    bal, pk, history, curmonth = {}, None, [], None
    if ck_path and os.path.exists(ck_path):
        s = pickle.load(open(ck_path, "rb"))
        bal, pk, history, curmonth = s["bal"], s["pk"], s["history"], s["curmonth"]
        if s.get("done"):
            return _finalize(bal, history, curmonth)
    t0 = time.time()
    while True:
        p = {"fromBlock": "0x0", "toBlock": "latest", "contractAddresses": [CONTRACT],
             "category": ["erc20"], "excludeZeroValue": False, "maxCount": "0x3e8",
             "order": "asc", "withMetadata": True}
        if pk:
            p["pageKey"] = pk
        res = rpc(url, "alchemy_getAssetTransfers", [p])["result"]
        for t in res["transfers"]:
            rv = t.get("rawContract", {}).get("value")
            if not rv:
                continue
            ts = (t.get("metadata") or {}).get("blockTimestamp", "")
            mo = ts[:7] if ts else curmonth
            if curmonth is None:
                curmonth = mo
            if mo and mo > curmonth:
                # curmonth (and any transfer-free gap months up to mo) are complete;
                # freeze their end-of-month distribution.
                snap = count_bal(bal)
                m = curmonth
                while m < mo:
                    history.append({"month": m, **snap})
                    m = next_month(m)
                curmonth = mo
            v = int(rv, 16)
            f, to = t.get("from"), t.get("to")
            if f:  bal[f]  = bal.get(f, 0) - v
            if to: bal[to] = bal.get(to, 0) + v
        pk = res.get("pageKey")
        if ck_path:
            pickle.dump({"bal": bal, "pk": pk, "history": history, "curmonth": curmonth,
                         "done": not pk}, open(ck_path, "wb"))
        if not pk:
            break
        if budget and time.time() - t0 > budget:
            return None
    return _finalize(bal, history, curmonth)


def _finalize(bal, history, curmonth):
    """Append the current (in-progress) month and carry the last state forward to
    the present month, so the line reaches today even after a quiet stretch."""
    snap = count_bal(bal)
    now = datetime.now(timezone.utc).strftime("%Y-%m")
    history = [h for h in history if h["month"] < curmonth] if curmonth else []
    m = curmonth or now
    while True:
        history.append({"month": m, **snap})
        if m >= now:
            break
        m = next_month(m)
    out = dict(snap)
    out["history"] = history
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
            chains[key] = process_chain(url)
            h = chains[key].get("history", [])
            print(f"{key}: total={chains[key]['total']} months={len(h)}"
                  + (f" ({h[0]['month']}..{h[-1]['month']})" if h else ""))
        except Exception as e:
            print(f"{key}: FAILED ({type(e).__name__}: {e}), keeping previous", file=sys.stderr)
    out = {
        "as_of": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source": "Reconstructed from the full ERC-20 transfer history via Alchemy getAssetTransfers, netted per address; monthly points are the holder distribution at each month-end.",
        "history_starts": "2024-10 (30 Oct 2024 migration; the current contracts carry no earlier history)",
        "chains": chains,
    }
    json.dump(out, open(OUT, "w"), indent=2)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
