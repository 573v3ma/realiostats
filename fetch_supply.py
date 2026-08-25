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
import json, os, re, sys, urllib.request, urllib.parse
from datetime import datetime, timezone  # noqa: F401 (used by fetch_native liveness)

TIMEOUT = 20
NATIVE_CAP = 175_000_000
BLOCK_SPAN = 20_000   # blocks to average block-time over (~31h; within pruning windows)

def _parse_cosmos_ts(t):
    """Cosmos block times can carry nanoseconds, which the stdlib parser rejects.
    Trim the fractional part to microseconds and return epoch seconds."""
    t = t.strip().replace("Z", "+00:00")
    m = re.match(r"(.*T\d\d:\d\d:\d\d)(\.\d+)?(.*)$", t)
    if m:
        t = m.group(1) + (m.group(2) or "")[:7] + (m.group(3) or "")
    return datetime.fromisoformat(t).timestamp()

def measure_block_time(url):
    """Average seconds/block over the last BLOCK_SPAN blocks, or None.
    The mint module issues annual_provisions/blocks_per_year PER BLOCK, so the
    real daily issuance depends on how fast blocks are actually produced, not on
    the nominal block time baked into the blocks_per_year parameter."""
    hdr = _get(f"{url}/cosmos/base/tendermint/v1beta1/blocks/latest")["block"]["header"]
    hN = int(hdr["height"]); tN = _parse_cosmos_ts(hdr["time"])
    hE = hN - BLOCK_SPAN
    if hE < 1:
        return None
    old = _get(f"{url}/cosmos/base/tendermint/v1beta1/blocks/{hE}")["block"]["header"]
    dt = tN - _parse_cosmos_ts(old["time"])
    return dt / BLOCK_SPAN if dt > 0 else None

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
# Balances that are provably OUTSIDE Realio's control but are NOT public float.
# 25 Aug 2026: this account was created at round 64396365 and, between 04:52:50
# and 08:39:30 UTC, received balances swept from 8,908 distinct Algorand
# accounts together with the entire reserve holding (43,850,860 RIO, tx
# WV3XE2N7BTBB, 05:24 UTC). Those RIO are not circulating in the sense this site
# measures (a holder deciding whether to hold or sell), and they are equally not
# Realio-controlled, so folding them into either bucket would be wrong. They get
# their own line and are never silently absorbed into float. See incident.html.
ALGO_COMPROMISED = {
    "RCES4II33PXVDX4ISQ3TWUZN5DP7JM6ZTDBJLARYQH53O4OLN5QTNYUJ6A":
        "2026-08-25 Algorand custodial sweep",
}
STELLAR_ISSUER = "GBNLJIYH34UWO5YZFA3A3HD3N76R6DOI33N4JONUOHEEYZYCAYTEJ5AK"
STELLAR_TREASURY = "GBRKMQ4IO5UURRRFLGLDIWBOWEF7ENC2BU5PB26ATAQRSWIZALE5EW2L"
# Same 25 Aug 2026 incident, Stellar leg. This account was created at 03:31:47
# UTC by the treasury itself, then received the treasury's entire RIO balance
# (69,869,351.74) at 07:25:19 UTC plus two later sweeps of deposits that arrived
# after the drain. Excluded from float on the same reasoning as the Algorand
# wallet: outside Realio's control, but not a holder's float either.
STELLAR_COMPROMISED = {
    "GBDMMICWFVSSU5YIKIVWG6EP3U65R2GIF7BICN3JIBES5NVGFZFLWXKZ":
        "2026-08-25 Stellar treasury drain",
}
NATIVE_DENOM = "ario"
NATIVE_BRIDGE_MODULE = "realio1zlefkpe3g0vvm9a4h0jf9000lmqutlh9jzcavp"
# Third leg of the 25 Aug 2026 incident, on the native chain. Between 09:29:23 and
# 10:15:22 UTC this account received 5,732,040.91 ario from 2,374 distinct accounts,
# one transfer each, and has never sent a transaction. 2,349 of those 2,374 accounts
# now hold exactly 0.001 RIO, the residue of the sweep. Unlike the Algorand and
# Stellar legs this came out of ordinary holder balances, which ARE counted in
# circulating supply, so it must be subtracted rather than left in float.
# A same-chain sweep does not change total supply by a single token, which is why
# the supply-level checks did not see it.
NATIVE_COMPROMISED = {
    "realio1uzkdrfnjv53rt0cf4ltszffpd7mvkpd2cv794j":
        "2026-08-25 native holder sweep",
}

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

def _evm_daily_mint_cap(rpc, c): return _evm_call(rpc, c, "0x2832bcb5")  # dailyMintCap()
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
    comp = {a: round(held(a), 4) for a in ALGO_COMPROMISED}
    comp_total = round(sum(comp.values()), 4)
    return {"total_supply": round(total, 4), "reserve": round(reserve, 4),
            "bridge_wallet": round(bridge, 4),
            "compromised": comp_total, "compromised_detail": comp,
            "circulating": round(total - reserve - bridge - comp_total, 4)}

def fetch_stellar(url):
    r = _get(f"{url}/assets?asset_code=RIO&asset_issuer={STELLAR_ISSUER}")["_embedded"]["records"][0]
    b = r["balances"]
    total = (sum(float(v) for v in b.values())
             + float(r.get("claimable_balances_amount", 0))
             + float(r.get("liquidity_pools_amount", 0))
             + float(r.get("contracts_amount", 0)))
    def rio_balance(addr):
        try:
            acct = _get(f"{url}/accounts/{addr}")
        except Exception:
            return 0.0
        for bal in acct.get("balances", []):
            if bal.get("asset_code") == "RIO" and bal.get("asset_issuer") == STELLAR_ISSUER:
                return float(bal["balance"])
        return 0.0
    treasury = rio_balance(STELLAR_TREASURY)
    comp = {a: round(rio_balance(a), 4) for a in STELLAR_COMPROMISED}
    comp_total = round(sum(comp.values()), 4)
    return {"total_supply": round(total, 4), "treasury": round(treasury, 4),
            "compromised": comp_total, "compromised_detail": comp,
            "circulating": round(total - treasury - comp_total, 4)}

# A halted chain keeps serving its last committed state, so every supply figure
# below still returns a number and nothing looks wrong. The Realio native chain
# stopped producing blocks at 10:38:05 UTC on 25 Aug 2026, so the reading is now
# explicitly timestamped and staleness is flagged rather than assumed away.
NATIVE_STALE_S = 600

def fetch_native(url):
    s = _get(f"{url}/cosmos/bank/v1beta1/supply/by_denom?denom={NATIVE_DENOM}")
    total = int(s["amount"]["amount"]) / 10**18
    esc = _get(f"{url}/cosmos/bank/v1beta1/balances/{NATIVE_BRIDGE_MODULE}")
    escrow = 0.0
    for c in esc.get("balances", []):
        if c["denom"] == NATIVE_DENOM: escrow = int(c["amount"]) / 10**18
    comp = {}
    for addr in NATIVE_COMPROMISED:
        try:
            b = _get(f"{url}/cosmos/bank/v1beta1/balances/{addr}/by_denom?denom={NATIVE_DENOM}")
            comp[addr] = round(int(b["balance"]["amount"]) / 10**18, 4)
        except Exception:
            comp[addr] = 0.0
    comp_total = round(sum(comp.values()), 4)
    out = {"total": round(total, 4), "bridge_escrow": round(escrow, 4),
           "compromised": comp_total, "compromised_detail": comp,
           "circulating": round(total - comp_total, 4)}
    try:
        hdr = _get(f"{url}/cosmos/base/tendermint/v1beta1/blocks/latest")["block"]["header"]
        age = datetime.now(timezone.utc).timestamp() - _parse_cosmos_ts(hdr["time"])
        out["height"] = int(hdr["height"])
        out["block_time_utc"] = hdr["time"]
        out["block_age_s"] = round(age, 1)
        out["chain_live"] = age <= NATIVE_STALE_S
    except Exception:
        pass
    return out

# ---- Realio emission (custom mint module; soft-fail, never blocks the snapshot) --
def fetch_mint_params(flags):
    for url in ENDPOINTS["native"]:
        try:
            d = _get(f"{url}/realionetwork/mint/v1/params")["params"]
            out = {"mint_denom": d.get("mint_denom"),
                   "inflation_rate": float(d["inflation_rate"]),
                   "blocks_per_year": int(d["blocks_per_year"])}
            # annual_provisions = inflation_rate x UNMINTED native supply (cap - supply),
            # the authoritative issuance figure; declines as native approaches the cap.
            try:
                ap = _get(f"{url}/realionetwork/mint/v1/annual_provisions")["annual_provisions"]
                out["annual_provisions_rio"] = float(ap) / 1e18
            except Exception:
                pass
            # Measure real block production so expected issuance reflects the
            # chain's actual pace, not the 5s the blocks_per_year param assumes.
            try:
                bt = measure_block_time(url)
                if bt and bt > 0:
                    out["block_time_s"] = round(bt, 4)
            except Exception:
                pass
            return out
        except Exception:
            continue
    flags.append("mint_params_unavailable")
    return {}

# ---- bridge rate limits (informational; soft-fail, never blocks the snapshot) --
# Two independent throttles, in two directions:
#   * EVM dailyMintCap: caps minting ONTO each EVM chain (any -> BSC / any -> ETH,
#     which is the native -> sellable-venue direction). Mutable by the bridge admin.
#   * Native bridge ratelimit: caps BridgeIn (EVM -> native, minting ario). 24h
#     epoch, authority-gated. Does NOT limit native -> EVM. Verified from source
#     (realiotech/realio-network x/bridge): only BridgeIn calls UpdateInflow.
def fetch_bridge_caps():
    out = {}
    for key, contract in (("bnb", BSC_CONTRACT), ("ethereum", ETH_CONTRACT)):
        for url in ENDPOINTS[key]:
            try:
                out["evm_daily_mint_cap_" + ("bnb" if key == "bnb" else "eth")] = \
                    round(_evm_daily_mint_cap(url, contract) / 1e18, 2)
                break
            except Exception:
                continue
    for url in ENDPOINTS["native"]:
        try:
            d = _get(f"{url}/realionetwork/bridge/v1/ratelimits")
            for rl in d.get("ratelimits", []):
                if rl.get("denom") == NATIVE_DENOM:
                    out["native_bridge_ratelimit"] = round(int(rl["rate_limit"]["ratelimit"]) / 1e18, 2)
                    break
            break
        except Exception:
            continue
    return out

# ---- native holder counts by threshold (keyless; soft-fail) ------------------
# Native holder-base metric, counting each wallet's TOTAL position = liquid RIO
# (bank ario) + staked RIO. Most native RIO is delegated, and delegated tokens
# are pooled in the multistaking module account, so a liquid-only count both
# hides real stakers and counts the pool itself as a holder. We therefore:
#   1. exclude module/pool accounts,
#   2. add each wallet's liquid ario, and
#   3. add each wallet's staked amount, summed across every validator.
# Staked uses the network's bonded "stake" (bond weights are 1:1), the same
# figure the official Realio validator pages display. Note: Realio staking is
# multi-denom, so total bonded stake bundles native RIO with RST and a bridged
# token; isolating pure-RIO stake per wallet needs the multistaking module's
# per-lock breakdown, which is not exposed publicly (all those routes 501).
def _paginate(base, path, field, cap=60):
    key, items = None, []
    for _ in range(cap):
        url = f"{base}{path}{'&' if '?' in path else '?'}pagination.limit=1000"
        if key:
            url += "&pagination.key=" + urllib.parse.quote(key, safe="")
        d = _get(url)
        items += d.get(field, [])
        key = d.get("pagination", {}).get("next_key")
        if not key:
            return items
    raise RuntimeError("pagination cap hit for " + path)

def fetch_native_holders(flags):
    for base in ENDPOINTS["native"]:
        try:
            # module/pool accounts to exclude (multistaking pool, distribution, etc.)
            mods = set()
            for m in _get(f"{base}/cosmos/auth/v1beta1/module_accounts").get("accounts", []):
                acc = m.get("base_account") or {}
                a = acc.get("address") or m.get("address")
                if a:
                    mods.add(a)
            bal = {}
            # 1) liquid ario
            for o in _paginate(base, f"/cosmos/bank/v1beta1/denom_owners/{NATIVE_DENOM}", "denom_owners"):
                a = o["address"]
                if a in mods:
                    continue
                bal[a] = bal.get(a, 0) + int(o["balance"]["amount"]) / 1e18
            # 2) staked, summed across every validator
            vals = _paginate(base, "/cosmos/staking/v1beta1/validators", "validators", cap=20)
            for v in vals:
                op = v["operator_address"]
                try:
                    for x in _paginate(base, f"/cosmos/staking/v1beta1/validators/{op}/delegations",
                                       "delegation_responses", cap=30):
                        a = x["delegation"]["delegator_address"]
                        if a in mods:
                            continue
                        bal[a] = bal.get(a, 0) + int(x["balance"]["amount"]) / 1e18
                except Exception:
                    continue  # skip a validator whose delegations page fails
            total = c100 = c1k = c10k = c100k = 0
            for amt in bal.values():
                if amt <= 0:
                    continue
                total += 1
                if amt >= 100:     c100 += 1
                if amt >= 1000:    c1k += 1
                if amt >= 10000:   c10k += 1
                if amt >= 100000:  c100k += 1
            if total:
                return {"total": total, "gte_100": c100, "gte_1k": c1k,
                        "gte_10k": c10k, "gte_100k": c100k}
        except Exception:
            continue
    flags.append("native_holders_unavailable")
    return None

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
# Each source returns (price_usd, volume_24h_usd_or_None). Volume is reported by
# exchanges, not measured on chain, so it is informational only and never feeds
# the supply-integrity checks.
#
# Only aggregators that report MARKET-WIDE 24h volume set the volume field.
# MEXC and KuCoin expose volume for a single pair, which is NOT the aggregate,
# so they return None rather than a number that would understate the real total.
#
# Note on CoinGecko: use the /simple/price headline volume, do NOT sum
# /coins/{id}/tickers. The ticker list includes pairs flagged is_stale (as of
# Jul 2026 a delisted MEXC RIO/EUR pair worth ~64K that CoinGecko has not yet
# removed). CoinGecko excludes stale pairs from the headline; summing the
# tickers ourselves would republish a dead market and overstate volume by ~27%.
def _p_coingecko():
    d=_get("https://api.coingecko.com/api/v3/simple/price?ids=realio-network&vs_currencies=usd&include_24hr_vol=true")["realio-network"]
    v=d.get("usd_24h_vol")
    return float(d["usd"]), (float(v) if v is not None else None)
def _p_mexc():
    return float(_get("https://api.mexc.com/api/v3/ticker/price?symbol=RIOUSDT")["price"]), None
def _p_kucoin():
    return float(_get("https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=RIO-USDT")["data"]["price"]), None
def _p_paprika():
    q=_get("https://api.coinpaprika.com/v1/tickers/rio-realio-network")["quotes"]["USD"]
    v=q.get("volume_24h")
    return float(q["price"]), (float(v) if v is not None else None)

PRICE_SOURCES = [("coingecko",_p_coingecko),("mexc",_p_mexc),("kucoin",_p_kucoin),("coinpaprika",_p_paprika)]

def fetch_price(flags):
    errs=[]
    for name,fn in PRICE_SOURCES:
        try:
            p,vol=fn()
            if p and p>0:
                if vol is None:
                    flags.append(f"volume_unavailable:{name}")
                return {"price_usd":p,"price_source":name,
                        "volume_24h_usd":(round(vol,2) if vol else None),
                        "volume_source":(name if vol else None)}
        except Exception as e:
            errs.append(f"{name}:{type(e).__name__}")
    flags.append("price_failed:"+"|".join(errs))
    return {"price_usd":None,"price_source":None,"volume_24h_usd":None,"volume_source":None}

# ---- excluded-wallet movement assertion ------------------------------------
# A wallet we exclude going to zero must never pass silently: the arithmetic
# would simply reclassify the balance as public float and publish a supply jump
# that never happened. That is exactly what occurred on 25 Aug 2026, when the
# Algorand reserve was drained at 05:24 UTC and the 06:33 UTC run reported
# Algorand float rising 7.84M -> 51.68M with no flag raised. Every excluded
# balance is now compared against the previous snapshot and any material move is
# flagged loudly. Soft-fail: a missing or unreadable history must never block a
# snapshot from being taken.
EXCL_MOVE_PCT = 0.02      # flag a move of more than 2% of the balance
EXCL_MOVE_ABS = 25_000    # ...but ignore noise below this many RIO

def _excluded_balances(chains):
    """Every balance the method subtracts from circulating, flattened."""
    out = {}
    a = chains.get("algorand") or {}
    if isinstance(a.get("reserve"), (int, float)):       out["algorand.reserve"] = a["reserve"]
    if isinstance(a.get("bridge_wallet"), (int, float)): out["algorand.bridge_wallet"] = a["bridge_wallet"]
    if isinstance(a.get("compromised"), (int, float)):   out["algorand.compromised"] = a["compromised"]
    x = chains.get("stellar") or {}
    if isinstance(x.get("treasury"), (int, float)):      out["stellar.treasury"] = x["treasury"]
    if isinstance(x.get("compromised"), (int, float)):  out["stellar.compromised"] = x["compromised"]
    n = chains.get("realio_native") or {}
    if isinstance(n.get("bridge_escrow"), (int, float)): out["native.bridge_escrow"] = n["bridge_escrow"]
    if isinstance(n.get("compromised"), (int, float)):   out["native.compromised"] = n["compromised"]
    return out

def check_excluded_movement(chains, flags, history_path=None):
    if history_path is None:
        history_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "supply-history.json")
    try:
        with open(history_path) as fh:
            hist = json.load(fh)
        prev = next((r for r in reversed(hist) if isinstance(r, dict) and r.get("chains")), None)
        if not prev:
            return
    except Exception:
        flags.append("excluded_movement_check_skipped")
        return
    before = _excluded_balances(prev.get("chains") or {})
    after  = _excluded_balances(chains)
    for k, was in before.items():
        now = after.get(k)
        if now is None:
            continue
        delta = now - was
        if abs(delta) < EXCL_MOVE_ABS:
            continue
        if was > 0 and abs(delta) / was < EXCL_MOVE_PCT:
            continue
        flags.append(f"EXCLUDED_WALLET_MOVED:{k}:{was:,.0f}->{now:,.0f}")

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
    compromised_total = round(
        (algo.get("compromised", 0) if isinstance(algo, dict) else 0)
        + (xlm.get("compromised", 0) if isinstance(xlm, dict) else 0)
        + (nat.get("compromised", 0) if isinstance(nat, dict) else 0), 2)

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
    if isinstance(nat, dict) and nat.get("chain_live") is False:
        flags.append(f"NATIVE_CHAIN_HALTED:height={nat.get('height')}:"
                     f"last_block={nat.get('block_time_utc')}:age_s={nat.get('block_age_s')}")
    check_excluded_movement(chains, flags)
    if compromised_total:
        flags.append(f"compromised_balance:{compromised_total:,.0f}")
    # if any chain failed entirely, the total is incomplete - make it loud
    if any(f.startswith("fetch_failed") for f in flags):
        flags.append("TOTAL_INCOMPLETE")

    # emission integrity: global RIO total (all chains incl. team wallets) grows
    # only by block-reward emission minus burns; bridging is net-zero globally.
    mint = fetch_mint_params(flags)
    infl = mint.get("inflation_rate")
    native_supply = nat.get("total", 0) if isinstance(nat, dict) else 0
    excluded = 0.0
    if isinstance(algo, dict):
        excluded += algo.get("reserve", 0) + algo.get("bridge_wallet", 0) + algo.get("compromised", 0)
    if isinstance(xlm, dict):  excluded += xlm.get("treasury", 0) + xlm.get("compromised", 0)
    # NOTE: native compromised is already inside nat["total"], so it is deliberately
    # NOT added here. Adding it would double-count it in the global figure.
    global_total = round(tradable + excluded, 2)
    # 8% is charged on the UNMINTED native supply (gap to the cap). Prefer the
    # chain's own annual_provisions; fall back to infl x (cap - native supply).
    ap_rio = mint.get("annual_provisions_rio")
    if ap_rio:
        ap_annual = round(ap_rio, 2)
    elif infl and native_supply:
        ap_annual = round(infl * max(NATIVE_CAP - native_supply, 0), 2)
    else:
        ap_annual = None

    # NOMINAL expected = annual_provisions / 365, which assumes the chain hits the
    # block time baked into blocks_per_year (5s). Realio actually runs slower, so
    # this OVERSTATES real issuance by ~12% and made observed net-new look like a
    # permanent shortfall (verified Jul 2026: 5.68s/block vs 5s assumed).
    exp_daily_nominal = round(ap_annual / 365, 2) if ap_annual else None

    # BLOCK-ADJUSTED expected = actual per-block issuance x actual blocks/day.
    # per-block = annual_provisions / blocks_per_year; blocks/day = 86400 / block_time.
    bpy = mint.get("blocks_per_year"); bt = mint.get("block_time_s")
    if ap_annual and bpy and bt and bt > 0:
        exp_daily = round(ap_annual * 86400 / (bpy * bt), 2)
        exp_annual = round(exp_daily * 365, 2)
        block_adjusted = True
    else:
        exp_daily = exp_daily_nominal
        exp_annual = ap_annual
        block_adjusted = False
        if ap_annual:  # had provisions but couldn't measure block time
            flags.append("emission_block_time_unavailable")
    price = fetch_price(flags)
    mcap = round(tradable * price["price_usd"], 2) if price["price_usd"] else None
    return {"ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "chains": chains, "tradable_total": tradable, "native_cap": NATIVE_CAP,
            "compromised_total": compromised_total,
            "price_usd": price["price_usd"], "price_source": price["price_source"],
            "market_cap_usd": mcap,
            "volume_24h_usd": price["volume_24h_usd"], "volume_source": price["volume_source"],
            "mint": {"inflation_rate": infl, "blocks_per_year": mint.get("blocks_per_year")},
            "global_total_rio": global_total,
            "expected_annual_emission_rio": exp_annual,
            "expected_daily_emission_rio": exp_daily,
            "expected_daily_emission_nominal_rio": exp_daily_nominal,
            "block_time_s": bt,
            "emission_block_adjusted": block_adjusted,
            "bridge_caps": fetch_bridge_caps(),
            "native_holders": fetch_native_holders(flags),
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
    if s.get("compromised_total"):
        print(f"  compromised      {s['compromised_total']:>18,.0f}   (attacker-held, excluded from float)")
    print(f"  native cap       {s['native_cap']:>18,.0f}   (context)")
    p = s.get("price_usd"); mc = s.get("market_cap_usd")
    print("-" * 66)
    print(f"  price (USD)      {('$'+format(p,'.5f')) if p else 'n/a':>18}   via {s.get('price_source')}")
    print(f"  market cap (USD) {('$'+format(mc,',.0f')) if mc else 'n/a':>18}   (circulating x price)")
    vol = s.get("volume_24h_usd")
    print(f"  24h volume (USD) {('$'+format(vol,',.0f')) if vol else 'n/a':>18}   (exchange-reported, via {s.get('volume_source') or 'n/a'})")
    print("-" * 66)
    infl = (s.get("mint") or {}).get("inflation_rate")
    print(f"  emission rate    {(format(infl*100,'.1f')+'%/yr') if infl else 'n/a':>18}   (8% of unminted native)")
    print(f"  expected new RIO {(format(s.get('expected_daily_emission_rio') or 0,',.0f')+'/day') if s.get('expected_daily_emission_rio') else 'n/a':>18}")
    bt = s.get("block_time_s")
    if bt:
        print(f"  block time       {format(bt,'.3f')+'s':>18}   (adj: nominal {format(s.get('expected_daily_emission_nominal_rio') or 0,',.0f')}/day -> real {format(s.get('expected_daily_emission_rio') or 0,',.0f')}/day)")
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
