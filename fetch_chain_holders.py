#!/usr/bin/env python3
"""
Holder counts for the remaining RIO chains: Algorand, Stellar, Solana and Base.

Unlike BNB and Ethereum (see fetch_evm_holders.py, which reconstructs balances
from full transfer history through a keyed Alchemy endpoint), every chain here
is read from a PUBLIC, KEYLESS endpoint:

  * Algorand : the indexer serves every ASA holding directly
               (/v2/assets/{asa}/balances), so the distribution is a straight
               read, no reconstruction.
  * Stellar  : Horizon lists every account trusting the asset
               (/accounts?asset=RIO:ISSUER) with its balance. Note the gap
               between TRUSTLINES and FUNDED holders: opening a trustline costs
               nothing and most are empty, so `total` counts only balances > 0,
               consistent with every other chain, and `trustlines` is reported
               separately rather than being passed off as a holder count.
  * Solana   : the RIO mint is a Token-2022 mint with 11 decimals. Token
               accounts are fetched with getProgramAccounts filtered on the mint
               and then aggregated BY OWNER, because one wallet can hold several
               token accounts for the same mint and counting accounts would
               inflate the holder count.
  * Base     : an EVM chain, so balances are netted from the ERC-20 Transfer log
               the same way as BNB/Ethereum, but the token is small enough that
               a public RPC serves the entire log range in one request, no key
               needed. Base is an OP-stack chain with an exact 2-second block
               time and zero observed drift from genesis, so a log's month comes
               from its block number arithmetically, which means the monthly
               history costs no extra calls. Reconciled against on-chain
               totalSupply() on every run.

Base therefore also gets a `history` list (same shape as holders-evm.json) and
joins the EVM evolution chart. The other three are current-snapshot only: their
tokens date from 2020 and reconstructing monthly history would mean walking
years of asset transactions, which is a different order of work for a line that
would barely move. Recorded as a deliberate limitation, not an oversight.

Base supply is bridged from Ethereum under lock-and-mint, so its RIO is already
counted in the Ethereum-side lock and contributes 0 to circulating supply. Its
holders are still real addresses and belong in the holder table, which counts
addresses per chain.

Writes holders-chains.json. A chain whose endpoints all fail keeps its previous
value and the run continues, so one flaky public node cannot blank the table.
"""
import json, os, sys, time, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "holders-chains.json")
TIMEOUT = 60
THRESHOLDS = [("gte_100", 100), ("gte_1k", 1000), ("gte_10k", 10000), ("gte_100k", 100000)]

ALGO_ASA = 2751733
ALGO_INDEXERS = ["https://mainnet-idx.algonode.cloud",
                 "https://mainnet-idx.4160.nodely.dev"]
ALGO_APIS = ["https://mainnet-api.algonode.cloud",
             "https://mainnet-api.4160.nodely.dev"]

STELLAR_ISSUER = "GBNLJIYH34UWO5YZFA3A3HD3N76R6DOI33N4JONUOHEEYZYCAYTEJ5AK"
STELLAR_HORIZONS = ["https://horizon.stellar.org",
                    "https://horizon.stellar.lobstr.co"]

SOL_MINT = "HELn8rSM1rp8vAjNH4NYXzX6FvCbwWMGqLfaMgiBnZFV"
SOL_RPCS = ["https://api.mainnet-beta.solana.com",
            "https://solana-rpc.publicnode.com"]

BASE_CONTRACT = "0x5e64c9049455b3bb6e9fbdc33565fa313bae9b53"
# Public Base RPCs that serve a full-range eth_getLogs. Most public endpoints cap
# the block range (1rpc: 50 blocks) or the payload; these are the ones verified
# to return the token's whole Transfer history in one call. If a future provider
# starts refusing, add another here rather than reaching for a keyed endpoint.
BASE_RPCS = ["https://base.gateway.tenderly.co",
             "https://base-rpc.publicnode.com",
             "https://mainnet.base.org"]
BASE_GENESIS_TS = 1686789347   # block 0, 15 Jun 2023
BASE_BLOCK_SECS = 2            # OP stack, fixed; verified 0s drift at 5M/20M/33M/45M
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO = "0x" + "0" * 40


def _get(url, tries=6):
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "realiostats/0.1"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.load(r)
        except Exception as e:
            last = e
            time.sleep(1.0 * (a + 1))
    raise last


def _post(url, payload, tries=4, timeout=None):
    last = None
    for a in range(tries):
        try:
            req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json", "User-Agent": "realiostats/0.1"})
            with urllib.request.urlopen(req, timeout=timeout or TIMEOUT) as r:
                return json.load(r)
        except Exception as e:
            last = e
            time.sleep(1.5 * (a + 1))
    raise last


def tiers_from(amounts):
    """Holder distribution from an iterable of positive balances."""
    o = {"total": 0}
    for k, _ in THRESHOLDS:
        o[k] = 0
    for amt in amounts:
        if amt <= 0:
            continue
        o["total"] += 1
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


# ---- Algorand ---------------------------------------------------------------
def fetch_algorand():
    dec = None
    for api in ALGO_APIS:
        try:
            dec = _get(f"{api}/v2/assets/{ALGO_ASA}")["params"]["decimals"]
            break
        except Exception:
            continue
    if dec is None:
        raise RuntimeError("could not read ASA decimals")
    err = None
    for idx in ALGO_INDEXERS:
        try:
            amounts, nxt, pages = [], None, 0
            while True:
                u = f"{idx}/v2/assets/{ALGO_ASA}/balances?limit=1000"
                if nxt:
                    u += "&next=" + nxt
                r = _get(u)
                pages += 1
                for b in r.get("balances", []):
                    if not b.get("deleted"):
                        amounts.append(b["amount"] / 10 ** dec)
                nxt = r.get("next-token")
                if not nxt or not r.get("balances") or pages > 200:
                    break
            out = tiers_from(amounts)
            out["opted_in"] = len(amounts)
            return out
        except Exception as e:
            err = e
            continue
    raise err


# ---- Stellar ----------------------------------------------------------------
def fetch_stellar():
    err = None
    for h in STELLAR_HORIZONS:
        try:
            trustlines = None
            try:
                rec = _get(f"{h}/assets?asset_code=RIO&asset_issuer={STELLAR_ISSUER}"
                           )["_embedded"]["records"][0]
                acc = rec.get("accounts") or {}
                trustlines = sum(v for v in acc.values() if isinstance(v, int))
            except Exception:
                pass
            url = f"{h}/accounts?asset=RIO:{STELLAR_ISSUER}&limit=200"
            amounts, pages = [], 0
            while True:
                d = _get(url)
                recs = d["_embedded"]["records"]
                pages += 1
                if not recs:
                    break
                for a in recs:
                    for b in a.get("balances", []):
                        if b.get("asset_code") == "RIO" and b.get("asset_issuer") == STELLAR_ISSUER:
                            amounts.append(float(b["balance"]))
                url = d["_links"]["next"]["href"]
                if pages > 400:
                    break
            out = tiers_from(amounts)
            if trustlines is not None:
                out["trustlines"] = trustlines
            return out
        except Exception as e:
            err = e
            continue
    raise err


# ---- Solana -----------------------------------------------------------------
def fetch_solana():
    err = None
    for rpc in SOL_RPCS:
        try:
            info = _post(rpc, {"jsonrpc": "2.0", "id": 1, "method": "getAccountInfo",
                               "params": [SOL_MINT, {"encoding": "jsonParsed"}]})["result"]["value"]
            program = info["owner"]          # Token-2022 for this mint
            r = _post(rpc, {"jsonrpc": "2.0", "id": 1, "method": "getProgramAccounts",
                            "params": [program, {"encoding": "jsonParsed",
                                                 "filters": [{"memcmp": {"offset": 0, "bytes": SOL_MINT}}]}]},
                      timeout=120)
            if "result" not in r:
                raise RuntimeError(str(r.get("error"))[:200])
            per_owner = defaultdict(float)
            for a in r["result"]:
                i = a["account"]["data"]["parsed"]["info"]
                per_owner[i["owner"]] += float(i["tokenAmount"]["uiAmount"] or 0)
            out = tiers_from(per_owner.values())
            out["token_accounts"] = len(r["result"])
            return out
        except Exception as e:
            err = e
            continue
    raise err


# ---- Base -------------------------------------------------------------------
def _base_month(block_number):
    ts = BASE_GENESIS_TS + BASE_BLOCK_SECS * block_number
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m")


def fetch_base():
    err = None
    for rpc in BASE_RPCS:
        try:
            logs = _post(rpc, {"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
                               "params": [{"address": BASE_CONTRACT, "topics": [TRANSFER_TOPIC],
                                           "fromBlock": "0x0", "toBlock": "latest"}]},
                         tries=2, timeout=120)
            if "result" not in logs:
                raise RuntimeError(str(logs.get("error"))[:200])
            logs = logs["result"]
            if not logs:
                raise RuntimeError("no transfer logs returned")
            logs.sort(key=lambda l: (int(l["blockNumber"], 16), int(l["logIndex"], 16)))

            bal, history, curmonth = defaultdict(int), [], None
            for l in logs:
                m = _base_month(int(l["blockNumber"], 16))
                if curmonth is None:
                    curmonth = m
                if m > curmonth:
                    snap = tiers_from([b / 10**18 for a, b in bal.items() if a != ZERO and b > 0])
                    while curmonth < m:
                        history.append({"month": curmonth, **snap})
                        curmonth = next_month(curmonth)
                v = int(l["data"], 16)
                frm = "0x" + l["topics"][1][-40:]
                to  = "0x" + l["topics"][2][-40:]
                bal[frm] -= v
                bal[to]  += v

            snap = tiers_from([b / 10**18 for a, b in bal.items() if a != ZERO and b > 0])
            now = datetime.now(timezone.utc).strftime("%Y-%m")
            m = curmonth or now
            while True:
                history.append({"month": m, **snap})
                if m >= now:
                    break
                m = next_month(m)

            # Reconcile the reconstruction against the contract's own supply.
            reconciled = None
            try:
                ts_hex = _post(rpc, {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                                     "params": [{"to": BASE_CONTRACT, "data": "0x18160ddd"}, "latest"]})["result"]
                onchain = int(ts_hex, 16) / 10**18
                summed = sum(b for a, b in bal.items() if a != ZERO and b > 0) / 10**18
                reconciled = round(abs(summed - onchain) / onchain * 100, 6) if onchain else None
                if reconciled is not None and reconciled > 0.05:
                    raise RuntimeError(f"base reconciliation off by {reconciled}%")
            except RuntimeError:
                raise
            except Exception:
                pass

            out = dict(snap)
            out["history"] = history
            out["transfers"] = len(logs)
            if reconciled is not None:
                out["supply_delta_pct"] = reconciled
            return out
        except Exception as e:
            err = e
            continue
    raise err


def main():
    try:
        chains = (json.load(open(OUT)).get("chains") or {})
    except Exception:
        chains = {}
    ok = 0
    for key, fn in (("algorand", fetch_algorand), ("stellar", fetch_stellar),
                    ("solana", fetch_solana), ("base", fetch_base)):
        t0 = time.time()
        try:
            chains[key] = fn()
            ok += 1
            print(f"{key}: total={chains[key]['total']} "
                  f"100+={chains[key]['gte_100']} 1k+={chains[key]['gte_1k']} "
                  f"10k+={chains[key]['gte_10k']} 100k+={chains[key]['gte_100k']} "
                  f"({time.time() - t0:.1f}s)")
        except Exception as e:
            print(f"{key}: FAILED ({type(e).__name__}: {e}), keeping previous", file=sys.stderr)
    if not ok:
        print("every chain failed, refusing to rewrite the file", file=sys.stderr)
        return 1
    out = {
        "as_of": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "source": ("Read from public keyless endpoints: Algorand indexer asset balances, "
                   "Stellar Horizon accounts by asset, Solana getProgramAccounts on the "
                   "Token-2022 mint aggregated by owner, and Base ERC-20 Transfer logs netted "
                   "per address and reconciled against on-chain total supply."),
        "notes": {
            "counting": "total counts addresses with a balance above zero, the same definition used for every other chain.",
            "stellar": "trustlines counts accounts that trust the asset, most of which hold nothing; total counts funded holders only.",
            "solana": "Token-2022 mint with 11 decimals; token accounts are aggregated by owner so one wallet counts once.",
            "base": "Bridged under lock-and-mint from Ethereum, so Base RIO adds nothing to circulating supply; these are holder addresses only.",
            "history": "Only Base carries a monthly history. Algorand, Stellar and Solana are current-snapshot only, because their 2020-era assets would need a full multi-year transaction walk to reconstruct.",
        },
        "chains": chains,
    }
    json.dump(out, open(OUT, "w"), indent=2)
    print("wrote", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
