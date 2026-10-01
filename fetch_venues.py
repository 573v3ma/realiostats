#!/usr/bin/env python3
"""
Exchange and DEX balances for the liquidity section ("held on exchanges & DEXs").

holders.json is the hand-kept REGISTRY: which wallets belong to which venue
(addresses taken from BscScan / Etherscan public name tags) and whether that
venue has a working RIO market (the "no active market" note, checked against
the CoinGecko ticker list). Balances in it are only a fallback.

This script reads the LIVE balance of every registered address with a plain
ERC-20 balanceOf call and writes the result into holders-evm.json under
"venues", which the site prefers over the registry's static figures. It runs at
the end of the weekly holder job (fetch_evm_holders.py), because that workflow
can only commit holders-evm.json / holders-chains.json.

RPC: the Alchemy URLs when set, otherwise public keyless endpoints. A chain
whose reads fail keeps its previous venues block, so a flaky node never blanks
the figure.

Adding a venue: add its addresses to holders.json. Exchange wallets rotate, so
re-check the explorer top-holder lists every month or two for new labelled
wallets (and for venues that gained or lost a live market).
"""
import json, os, sys, time, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, "holders.json")
OUT = os.path.join(HERE, "holders-evm.json")
CONTRACT = "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"
CHAINS = {
    # registry key -> (env var, public fallbacks)
    "bsc_exchanges": ("ALCHEMY_BNB_URL", ["https://bsc-dataseed.bnbchain.org",
                                          "https://bsc-dataseed1.defibit.io",
                                          "https://bsc-rpc.publicnode.com"]),
    "eth_holders":   ("ALCHEMY_ETH_URL", ["https://rpc.mevblocker.io",
                                          "https://ethereum-rpc.publicnode.com",
                                          "https://eth.llamarpc.com"]),
}


def _call(url, addr):
    data = "0x70a08231" + addr[2:].lower().rjust(64, "0")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                       "params": [{"to": CONTRACT, "data": data}, "latest"]}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json",
                                                          "User-Agent": "realiostats"})
    d = json.load(urllib.request.urlopen(req, timeout=30))
    if "error" in d:
        raise RuntimeError(d["error"])
    return int(d["result"], 16) / 1e18


def balance(urls, addr):
    last = None
    for url in urls:
        for _ in range(3):
            try:
                return _call(url, addr)
            except Exception as e:
                last = e
                time.sleep(1)
    raise RuntimeError(f"all RPCs failed for {addr}: {last}")


def refresh_venues():
    reg = json.load(open(REGISTRY))
    try:
        out = json.load(open(OUT))
    except Exception:
        out = {}
    prev = out.get("venues") or {}
    venues = {"as_of": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
              "source": "Live balanceOf of the labelled exchange and DEX wallets listed in holders.json."}
    ok_any = False
    for key, (env, public) in CHAINS.items():
        urls = ([os.environ[env].strip()] if os.environ.get(env, "").strip() else []) + public
        try:
            rows = []
            for v in reg.get(key, []):
                addrs = v.get("addresses") or []
                if not addrs:
                    continue
                rio = sum(balance(urls, a) for a in addrs)
                row = {k: v[k] for k in v if k not in ("addresses", "rio")}
                row["rio"] = round(rio, 2)
                if key == "bsc_exchanges":
                    row["wallets"] = len(addrs)
                rows.append(row)
            venues[key] = rows
            ok_any = True
            print(f"venues {key}: " + ", ".join(f"{r.get('entity') or r.get('holder')} {r['rio']/1e6:.2f}M" for r in rows))
        except Exception as e:
            print(f"::error::venues {key}: FAILED ({type(e).__name__}: {str(e)[:200]}), keeping previous", file=sys.stderr)
            if key in prev:
                venues[key] = prev[key]
                venues.setdefault("stale", []).append(key)
    if not ok_any and prev:
        return
    out["venues"] = venues
    json.dump(out, open(OUT, "w"), indent=2)
    print("wrote venues to", OUT)


if __name__ == "__main__":
    refresh_venues()
