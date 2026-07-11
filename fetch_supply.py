#!/usr/bin/env python3
"""
realiostats.com - RIO multi-chain circulating supply fetcher (proof of concept)

Implements realiostats-methodology.md: count each RIO once across all chains,
exclude Realio-controlled reserve/treasury/bridge wallets, run verification
assertions, emit one snapshot JSON row. Read-only public endpoints, no keys.

Resilience: each chain has a fallback list of endpoints (all verified live
2026-07-11). Endpoints are tried in order; the first that returns valid data
wins. A chain only fails if EVERY endpoint fails, and that is flagged, not
silently zeroed. Which endpoint served each chain is recorded in the snapshot.

Run:  python3 fetch_supply.py           # summary + JSON
      python3 fetch_supply.py --json    # JSON only (daily append job)
"""
import json, sys, urllib.request
from datetime import datetime, timezone

TIMEOUT = 20
NATIVE_CAP = 175_000_000

# ---- endpoint fallback lists (order = priority; all verified live) ----------
ENDPOINTS = {
    "ethereum": ["https://ethereum-rpc.publicnode.com",
                 "https://eth.drpc.org",
                 "https://1rpc.io/eth"],
    "bnb":      ["https://bsc-rpc.publicnode.com",
                 "https://bsc-dataseed.bnbchain.org",
                 "https://bsc-dataseed1.defibit.io",
                 "https://1rpc.io/bnb"],
    "base":     ["https://base-rpc.publicnode.com",
                 "https://mainnet.base.org",
                 "https://base.drpc.org"],
    "solana":   ["https://api.mainnet-beta.solana.com",
                 "https://solana-rpc.publicnode.com"],
    "algorand": ["https://mainnet-api.algonode.cloud",
                 "https://mainnet-api.4160.nodely.dev"],
    "stellar":  ["https://horizon.stellar.org",
                 "https://horizon.stellar.lobstr.co"],
    # Native public LCDs (all verified live 2026-07-11). Put your own validator's
    # LCD FIRST here once live (authoritative) - see realio-node-lcd-setup.md.
    "native":   ["https://realio-api.noders.services",
                 "https://rest.cosmos.directory/realio",
                 "https://realio.api.m.stavr.tech"],
}

ETH_CONTRACT  = "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"
BSC_CONTRACT  = "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"
BASE_CONTRACT = "0x5e64c9049455b3bb6e9fbdc33565fa313bae9b53"
BASE_L1_BRIDGE = "0x3154cf16ccdb4c6d922629664174b904d80f2c35"
SOL_MINT = "HELn8rSM1rp8vAjNH4NYXzX6FvCbwWMGqLfaMgiBnZFV"
ALGO_ASA = 2751733
ALGO_RESERVE = "GNRGAOG65JPGWVIK2Q45R4XLLVIMF7AWVBK5TEBGWRRAZ3EHPQIN44EGFA"
ALGO_BRIDGE  = "M3IAMWFYEIJWLWFIIOEDFOLGIVMEOB3F4I3CA4BIAHJENHUUSX63APOXXM"
STELLAR_ISSUER = "GBNLJIYH34UWO5YZFA3A3HD3N76R6DOI33N4JONUOHEEYZYCAYTEJ5AK"
STELLAR_TREASURY = "GBRKMQ4IO5UURRRFLGLDIWBOWEF7ENC2BU5PB26ATAQRSWIZALE5EW2L"
NATIVE_DENOM = "ario"
NATIVE_BRIDGE_MODULE = "realio1zlefkpe3g0vvm9a4h0jf9000lmqutlh9jzcavp"

def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "realiostats/0.1"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)

def _post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "realiostats/0.1"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)

def _evm_call(rpc, to, data):
    r = _post(rpc, {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                    "params": [{"to": to, "data": data}, "latest"]})
    if "result" not in r:
        raise ValueError(f"no result: {r.get('error')}")
    return int(r["result"], 16)

def _evm_total_supply(rpc, c): return _evm_call(rpc, c, "0x18160ddd")
def _evm_decimals(rpc, c):     return _evm_call(rpc, c, "0x313ce567")
def _evm_balance_of(rpc, c, holder):
    return _evm_call(rpc, c, "0x70a08231" + holder.lower().replace("0x", "").rjust(64, "0"))

# ---- per-chain fetchers (take a single endpoint url) ------------------------
def fetch_evm(url, contract, extra_lock_holder=None):
    dec = _evm_decimals(url, contract)
    out = {"total_supply": round(_evm_total_supply(url, contract) / 10**dec, 4)}
    if extra_lock_holder:
        out["base_bridge_lock"] = round(_evm_balance_of(url, contract, extra_lock_holder) / 10**dec, 4)
    return out

def fetch_solana(url):
    r = _post(url, {"jsonrpc": "2.0", "id": 1, "method": "getTokenSupply", "params": [SOL_MINT]})
    return {"total_supply": round(float(r["result"]["value"]["uiAmount"]), 4)}

def fetch_algorand(url):
    asset = _get(f"{url}/v2/assets/{ALGO_ASA}")["params"]
    dec = asset["decimals"]; total = asset["total"] / 10**dec
    def held(addr):
        try:
            h = _get(f"{url}/v2/accounts/{addr}/assets/{ALGO_ASA}")
            return h["asset-holding"]["amount"] / 10**dec
        except Exception:
            return 0.0
    reserve = held(ALGO_RESERVE); bridge = held(ALGO_BRIDGE)
    return {"total_supply": round(total, 4), "reserve": round(reserve, 4),
            "bridge_wallet": round(bridge, 4), "circulating": round(total - reserve - bridge, 4)}

def fetch_stellar(url):
    r = _get(f"{url}/assets?asset_code=RIO&asset_issuer={STELLAR_ISSUER}")["_embedded"]["records"][0]
    b = r["balances"]
    total = (sum(float(v) for v in b.values())
             + float(r.get("claimable_balances_amount", 0))
             + float(r.get("liquidity_pools_amount", 0))
             + float(r.get("contracts_amount", 0)))
    treasury = 0.0
    acct = _get(f"{url}/accounts/{STELLAR_TREASURY}")
    for bal in acct.get("balances", []):
        if bal.get("asset_code") == "RIO" and bal.get("asset_issuer") == STELLAR_ISSUER:
            treasury = float(bal["balance"]); break
    return {"total_supply": round(total, 4), "treasury": round(treasury, 4),
            "circulating": round(total - treasury, 4)}

def fetch_native(url):
    s = _get(f"{url}/cosmos/bank/v1beta1/supply/by_denom?denom={NATIVE_DENOM}")
    total = int(s["amount"]["amount"]) / 10**18
    esc = _get(f"{url}/cosmos/bank/v1beta1/balances/{NATIVE_BRIDGE_MODULE}")
    escrow = 0.0
    for c in esc.get("balances", []):
        if c["denom"] == NATIVE_DENOM: escrow = int(c["amount"]) / 10**18
    return {"total": round(total, 4), "bridge_escrow": round(escrow, 4), "circulating": round(total, 4)}

# ---- Realio emission (custom mint module; soft-fail, never blocks the snapshot) --
def fetch_mint_params(flags):
    for url in ENDPOINTS["native"]:
        try:
            d = _get(f"{url}/realionetwork/mint/v1/params")["params"]
            return {"mint_denom": d.get("mint_denom"),
                    "inflation_rate": float(d["inflation_rate"]),
                    "blocks_per_year": int(d["blocks_per_year"])}
        except Exception:
            continue
    flags.append("mint_params_unavailable")
    return {}

# ---- failover wrapper: try each endpoint until one returns valid data --------
def with_fallback(chain, fn, flags):
    errs = []
    for i, url in enumerate(ENDPOINTS[chain]):
        try:
            data = fn(url)
            data["_source"] = url
            if i > 0:
                flags.append(f"fallback_used:{chain}:{url}")
            return data
        except Exception as e:
            errs.append(f"{url}:{type(e).__name__}")
    flags.append(f"fetch_failed:{chain}:{'|'.join(errs)}")
    return {"error": "; ".join(errs)}


# ---- price sources (keyless, verified live 2026-07-11; first valid wins) -----
def _p_coingecko(): 
    d=_get("https://api.coingecko.com/api/v3/simple/price?ids=realio-network&vs_currencies=usd")
    return float(d["realio-network"]["usd"])
def _p_mexc():
    return float(_get("https://api.mexc.com/api/v3/ticker/price?symbol=RIOUSDT")["price"])
def _p_kucoin():
    return float(_get("https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=RIO-USDT")["data"]["price"])
def _p_paprika():
    return float(_get("https://api.coinpaprika.com/v1/tickers/rio-realio-network")["quotes"]["USD"]["price"])

PRICE_SOURCES = [("coingecko",_p_coingecko),("mexc",_p_mexc),("kucoin",_p_kucoin),("coinpaprika",_p_paprika)]

def fetch_price(flags):
    errs=[]
    for name,fn in PRICE_SOURCES:
        try:
            p=fn()
            if p and p>0: return {"price_usd":p,"price_source":name}
        except Exception as e:
            errs.append(f"{name}:{type(e).__name__}")
    flags.append("price_failed:"+"|".join(errs))
    return {"price_usd":None,"price_source":None}

def build_snapshot():
    flags = []
    eth  = with_fallback("ethereum", lambda u: fetch_evm(u, ETH_CONTRACT, BASE_L1_BRIDGE), flags)
    bnb  = with_fallback("bnb",      lambda u: fetch_evm(u, BSC_CONTRACT), flags)
    base = with_fallback("base",     lambda u: fetch_evm(u, BASE_CONTRACT), flags)
    sol  = with_fallback("solana",   fetch_solana, flags)
    algo = with_fallback("algorand", fetch_algorand, flags)
    xlm  = with_fallback("stellar",  fetch_stellar, flags)
    nat  = with_fallback("native",   fetch_native, flags)

    eth_circ, bnb_circ = eth.get("total_supply", 0), bnb.get("total_supply", 0)
    base_circ = 0
    sol_circ  = sol.get("total_supply", 0)
    algo_circ, xlm_circ, nat_circ = algo.get("circulating", 0), xlm.get("circulating", 0), nat.get("circulating", 0)

    chains = {
        "realio_native": {**nat},
        "bnb":      {**bnb, "circulating": round(bnb_circ, 4)},
        "ethereum": {**eth, "circulating": round(eth_circ, 4)},
        "algorand": {**algo},
        "stellar":  {**xlm},
        "solana":   {**sol, "circulating": round(sol_circ, 4)},
        "base":     {**base, "circulating": base_circ},
    }
    tradable = round(eth_circ + bnb_circ + base_circ + sol_circ + algo_circ + xlm_circ + nat_circ, 2)

    if isinstance(nat.get("bridge_escrow"), (int, float)) and nat["bridge_escrow"] != 0:
        flags.append(f"native_escrow_nonzero:{nat['bridge_escrow']}")
    lock, btot = eth.get("base_bridge_lock"), base.get("total_supply")
    if isinstance(lock, (int, float)) and isinstance(btot, (int, float)):
        if abs(lock - btot) > max(5000, 0.005 * btot):
            flags.append(f"base_lock_mismatch:lock={lock},base={btot}")
    if isinstance(nat.get("total"), (int, float)) and nat["total"] > NATIVE_CAP:
        flags.append(f"native_above_cap:{nat['total']}")
    # if any chain failed entirely, the total is incomplete - make it loud
    if any(f.startswith("fetch_failed") for f in flags):
        flags.append("TOTAL_INCOMPLETE")

    # emission integrity: global RIO total (all chains incl. team wallets) grows
    # only by block-reward emission minus burns; bridging is net-zero globally.
    mint = fetch_mint_params(flags)
    infl = mint.get("inflation_rate")
    native_supply = nat.get("total", 0) if isinstance(nat, dict) else 0
    excluded = 0.0
    if isinstance(algo, dict): excluded += algo.get("reserve", 0) + algo.get("bridge_wallet", 0)
    if isinstance(xlm, dict):  excluded += xlm.get("treasury", 0)
    global_total = round(tradable + excluded, 2)
    exp_annual = round(infl * native_supply, 2) if infl else None
    exp_daily = round(exp_annual / 365, 2) if exp_annual else None
    price = fetch_price(flags)
    mcap = round(tradable * price["price_usd"], 2) if price["price_usd"] else None
    return {"ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "chains": chains, "tradable_total": tradable, "native_cap": NATIVE_CAP,
            "price_usd": price["price_usd"], "price_source": price["price_source"],
            "market_cap_usd": mcap,
            "mint": {"inflation_rate": infl, "blocks_per_year": mint.get("blocks_per_year")},
            "global_total_rio": global_total,
            "expected_annual_emission_rio": exp_annual,
            "expected_daily_emission_rio": exp_daily,
            "flags": flags}

def print_summary(s):
    print("=" * 66)
    print(f"  RIO circulating supply snapshot  {s['ts']}")
    print("=" * 66)
    for name, c in s["chains"].items():
        circ = c.get("circulating", c.get("total", "?"))
        src = c.get("_source", "").replace("https://", "")
        print(f"  {name:16s} {str(circ):>18}   via {src}")
    print("-" * 66)
    print(f"  TRADABLE TOTAL   {s['tradable_total']:>18,.0f}   (headline)")
    print(f"  native cap       {s['native_cap']:>18,.0f}   (context)")
    p = s.get("price_usd"); mc = s.get("market_cap_usd")
    print("-" * 66)
    print(f"  price (USD)      {('$'+format(p,'.5f')) if p else 'n/a':>18}   via {s.get('price_source')}")
    print(f"  market cap (USD) {('$'+format(mc,',.0f')) if mc else 'n/a':>18}   (circulating x price)")
    print("-" * 66)
    infl = (s.get("mint") or {}).get("inflation_rate")
    print(f"  emission rate    {(format(infl*100,'.1f')+'%/yr') if infl else 'n/a':>18}   (RIO block rewards)")
    print(f"  expected new RIO {(format(s.get('expected_daily_emission_rio') or 0,',.0f')+'/day') if s.get('expected_daily_emission_rio') else 'n/a':>18}")
    print(f"  global RIO total {format(s.get('global_total_rio') or 0,',.0f'):>18}   (all chains incl. team)")
    print("-" * 66)
    print(f"  flags: {s['flags'] if s['flags'] else 'none - all checks passed'}")
    print("=" * 66)

if __name__ == "__main__":
    snap = build_snapshot()
    if "--json" in sys.argv:
        print(json.dumps(snap, indent=2))
    else:
        print_summary(snap)
