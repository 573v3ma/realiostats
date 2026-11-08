#!/usr/bin/env python3
"""
Large RIO transfers, every chain, rolling window (realiostats).

Lists every RIO transfer of THRESHOLD (100,000) RIO or more over the last
WINDOW_DAYS (30) days on all seven chains, with time, amount, from/to (labelled
where the address is known: exchange wallets, bridges, module accounts,
Realio reserve/treasury), and the tx hash. Writes large-transfers.json, which
the holders page renders.

Stdlib only. Per chain:

  BNB, Ethereum, Base
              With ALCHEMY_BNB_URL / ALCHEMY_ETH_URL set (the secrets the weekly
              holder job already uses; Base is derived from the ETH URL), the
              whole 30-day window is re-read every run via
              alchemy_getAssetTransfers. Without them, keyless eth_getLogs:
              BNB bsc-rpc.publicnode.com (50k-block cap, logs kept only ~2.5M
              blocks = ~13 days, and seen answering a throttled IP with EMPTY
              results, so treat keyless BNB as best effort), Ethereum
              rpc.mevblocker.io, Base base-rpc.publicnode.com.
  Solana      getSignaturesForAddress(mint) + getTransaction (Token-2022, 11 dp)
  Algorand    indexer /v2/assets/2751733/transactions?currency-greater-than=
              (the filter runs server-side, full history available)
  Stellar     Stellar RPC getEvents on the RIO Stellar Asset Contract. Since
              protocol 23 every classic payment emits a unified "transfer"
              event; Horizon has no asset filter for payments. Public RPCs keep
              only ~7 days of events, which is why this job is incremental.
  Native      rpc.realio.network tx_search (the only public Realio node with
              the tx index on; it is indexed back to height ~8.9M). Blocks are
              pruned to ~7 days there, so block times come from the official
              explorer's public Hasura (hasura.realio.network). If both fail,
              the time is interpolated from the block rate and flagged time_est.

Incremental: each chain keeps a cursor (last block / ledger / round /
signature scanned) inside the JSON, so a daily run only reads one day of new
data and the window fills forward. The first run backfills as far as each
source allows (30 days everywhere except Stellar, ~7 days). A chain that fails
keeps its previous rows and cursor and is flagged stale; it never blocks the
others, and the workflow step is continue-on-error so it never blocks the
supply snapshot.

Classification (recomputed on every run, so better labels apply to old rows):
  bridge_out / bridge_in   burn/mint on the burn-and-mint bridge (EVM zero
                           address, native MsgBridgeOut/In, Solana supply
                           change), and the Ethereum <-> Base lock-and-mint
                           bridge. Legs are paired across chains when an out
                           and an in of near-equal amount land within 72h.
  ibc_out / ibc_in         native <-> Osmosis (or other IBC chain)
  deposit / withdrawal     to / from a labelled exchange wallet
  exchange                 between two wallets of the same exchange
  dex                      to / from a labelled DEX pool
  mint / burn              Stellar issuer
  wallet                   everything else
Staking, unstaking and reward claims on the native chain are not transfers
and are left out (module accounts: multistaking, bonded pools, distribution,
fee collector).
"""
import base64, hashlib, json, os, struct, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "large-transfers.json")
HOLDERS = os.path.join(HERE, "holders.json")

THRESHOLD = 100_000
WINDOW_DAYS = 30
PAIR_WINDOW_S = 72 * 3600
PAIR_TOL = 0.005            # bridge legs pair if amounts are within 0.5%
MAX_CALLS_PER_RUN = 400     # eth_getLogs calls per chain per run (resumes next run)
# Keyless log depth we trust, in blocks. Measured 8 Nov 2026: publicnode BNB
# returns real logs for the last ~400k blocks (~2 days at 0.45s), then EMPTY
# results (no error) back to ~2.47M blocks, then HTTP 403; 48.club keeps ~1M.
# An empty answer is indistinguishable from "no transfers", so never read
# deeper than this without a key. A daily run only needs ~192k blocks.
KEYLESS_DEPTH = {"bnb": 380_000}
TIMEOUT = 60
UA = {"User-Agent": "realiostats/0.1 (+https://realiostats.com)"}

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO_EVM = "0x0000000000000000000000000000000000000000"
EVM = {
    # chain: (contract, decimals, [(rpc, max block range)])
    # Checked 8 Nov 2026: publicnode is the only public BNB RPC serving a useful
    # getLogs range (bnbchain dataseeds refuse getLogs, 1rpc caps at 50 blocks,
    # drpc/blastapi/blockpi rate-limit or fail). 48.club allows 500 blocks: fine
    # for a one-day incremental run, too slow for a 30-day backfill.
    "bnb": ("0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0", 18,
            [("https://bsc-rpc.publicnode.com", 50_000),
             ("https://rpc-bsc.48.club", 5_000)]),
    "eth": ("0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0", 18,
            [("https://rpc.mevblocker.io", 100_000),
             ("https://ethereum-rpc.publicnode.com", 50_000)]),
    "base": ("0x5e64c9049455b3bb6e9fbdc33565fa313bae9b53", 18,
             [("https://base-rpc.publicnode.com", 50_000),
              ("https://base.gateway.tenderly.co", 1_000)]),
}
BASE_L1_BRIDGE = "0x3154cf16ccdb4c6d922629664174b904d80f2c35"   # on Ethereum
BASE_L2_BRIDGE = "0x4200000000000000000000000000000000000010"   # on Base

SOL_MINT = "HELn8rSM1rp8vAjNH4NYXzX6FvCbwWMGqLfaMgiBnZFV"
SOL_DEC = 11
SOL_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"]

ALGO_ASA = 2751733
ALGO_DEC = 7
ALGO_IDX = ["https://mainnet-idx.algonode.cloud", "https://mainnet-idx.4160.nodely.dev"]

STELLAR_ISSUER = "GBNLJIYH34UWO5YZFA3A3HD3N76R6DOI33N4JONUOHEEYZYCAYTEJ5AK"
STELLAR_DEC = 7
STELLAR_RPCS = ["https://rpc.lightsail.network", "https://soroban-rpc.mainnet.stellar.gateway.fm",
                "https://mainnet.sorobanrpc.com"]

NATIVE_RPC = "https://rpc.realio.network"
# Big Dipper explorer backend: public, keyless, exact block time at any height
NATIVE_HASURA = "https://hasura.realio.network/v1/graphql"
NATIVE_LCDS = ["https://realio-api.noders.services", "https://rest.cosmos.directory/realio"]
NATIVE_DEC = 18
NATIVE_DENOM = "ario"
# module accounts whose flows are staking / rewards / fees, not transfers
NATIVE_SKIP_MODULES = {"bonded_tokens_pool", "not_bonded_tokens_pool", "distribution",
                       "fee_collector", "multistaking", "mint", "gov"}

# ---- static labels (addresses we already know; exchange wallets come from holders.json)
STATIC_LABELS = {
    "eth": {BASE_L1_BRIDGE: ("Base bridge (escrow)", "bridge")},
    "base": {BASE_L2_BRIDGE: ("Base bridge", "bridge")},
    "algorand": {
        "GNRGAOG65JPGWVIK2Q45R4XLLVIMF7AWVBK5TEBGWRRAZ3EHPQIN44EGFA": ("Realio reserve", "team"),
        "M3IAMWFYEIJWLWFIIOEDFOLGIVMEOB3F4I3CA4BIAHJENHUUSX63APOXXM": ("MEXC custody (retired)", "exchange"),
        "ZEJPIFQF5MSDOB3YA6OUG4S26FFX64SCTHKDMYCCB26JGG7DC4IPBWQSLQ": ("MEXC hot wallet", "exchange"),
        "O5PL7CXYDK3TLGKSDTABLABYDZYM55UMS34P4RJEE3WABW45QI2JFC7OCA": ("Reissue return wallet", "team"),
        "RCES4II33PXVDX4ISQ3TWUZN5DP7JM6ZTDBJLARYQH53O4OLN5QTNYUJ6A": ("25 Aug 2026 attacker", "attacker"),
    },
    "stellar": {
        STELLAR_ISSUER: ("RIO issuer", "issuer"),
        "GBRKMQ4IO5UURRRFLGLDIWBOWEF7ENC2BU5PB26ATAQRSWIZALE5EW2L": ("Realio treasury", "team"),
        "GBDMMICWFVSSU5YIKIVWG6EP3U65R2GIF7BICN3JIBES5NVGFZFLWXKZ": ("25 Aug 2026 attacker", "attacker"),
    },
    "native": {
        "realio1uzkdrfnjv53rt0cf4ltszffpd7mvkpd2cv794j": ("25 Aug 2026 attacker", "attacker"),
        "realio1usws4ccu3m7ln6m5gesc3m8jqcl0fqagq32kv6": ("Bridge relayer", "bridge"),
    },
}


# ---------------------------------------------------------------- http helpers
def _get(url, tries=5, timeout=TIMEOUT):
    for a in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404) or a == tries - 1:
                raise
            time.sleep(1.5 * (a + 1) + (5 if e.code == 429 else 0))
        except Exception:
            if a == tries - 1:
                raise
            time.sleep(1.5 * (a + 1))


def _rpc(url, method, params, tries=5, timeout=TIMEOUT):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for a in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers={**UA, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                d = json.load(r)
            if "error" in d:
                msg = str(d["error"]).lower()
                if any(x in msg for x in ("rate", "too many", "busy", "timeout")) and a < tries - 1:
                    time.sleep(2 * (a + 1)); continue
                raise RuntimeError(f"{method}: {d['error']}")
            return d["result"]
        except urllib.error.HTTPError as e:
            if a == tries - 1 or e.code in (400, 404, 413):
                raise
            time.sleep(2 * (a + 1) + (6 if e.code == 429 else 0))
        except RuntimeError:
            raise
        except Exception:
            if a == tries - 1:
                raise
            time.sleep(2 * (a + 1))


def iso(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    s = s.rstrip("Z")
    if "." in s:
        s = s[:s.index(".")]
    return int(datetime.strptime(s, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp())


# ---------------------------------------------------------------- EVM chains
def _evm_block_ts(url, n, cache):
    if n not in cache:
        b = _rpc(url, "eth_getBlockByNumber", [hex(n), False])
        if not b:
            raise LookupError(f"block {n} not served")
        cache[n] = int(b["timestamp"], 16)
    return cache[n]


def _evm_block_at(url, ts, head, cache):
    """First block with timestamp >= ts. Estimates from the recent block rate,
    then binary-searches a bracket around the estimate, so a non-archive node is
    never asked for an ancient block."""
    probe = max(1, head - 100_000)
    t_head, t_probe = _evm_block_ts(url, head, cache), _evm_block_ts(url, probe, cache)
    bt = max(0.05, (t_head - t_probe) / max(1, head - probe))
    est = int(head - (t_head - ts) / bt)
    lo = max(1, est - int(0.25 * (head - est)) - 1000)
    try:
        while lo > 1 and _evm_block_ts(url, lo, cache) >= ts:      # block rate changed: widen
            lo = max(1, lo - (head - lo))
    except LookupError:
        return max(1, est)      # node has no headers that old; the logs probe handles the rest
    hi = head
    while lo < hi:
        mid = (lo + hi) // 2
        if _evm_block_ts(url, mid, cache) < ts:
            lo = mid + 1
        else:
            hi = mid
    return lo


def _logs_ok(url, contract, b):
    try:
        _rpc(url, "eth_getLogs", [{"address": contract, "topics": [TRANSFER_TOPIC],
                                   "fromBlock": hex(b), "toBlock": hex(b)}], tries=1, timeout=30)
        return True
    except Exception:
        return False


def _evm_oldest_served(url, contract, lo, hi):
    """Oldest block (to ~1,000 blocks) whose logs the node still serves."""
    while hi - lo > 1000:
        mid = (lo + hi) // 2
        time.sleep(0.5)
        if _logs_ok(url, contract, mid):
            hi = mid
        else:
            lo = mid
    return hi + 2000      # small margin: the pruning edge moves forward as we scan


class PartialScan(Exception):
    def __init__(self, logs, last_done, err):
        super().__init__(str(err)); self.logs, self.last_done = logs, last_done


def _evm_logs(url, contract, a, b, span):
    """Transfer logs in [a, b], chunked and paced. A refused range is halved; a
    rate limit (HTTP 403/429/5xx) is waited out. If the RPC gives up part way,
    PartialScan carries what was read so the next run resumes from there."""
    out, start, cool = [], a, 0
    while start <= b:
        end = min(b, start + span - 1)
        try:
            out += _rpc(url, "eth_getLogs", [{"address": contract, "topics": [TRANSFER_TOPIC],
                                             "fromBlock": hex(start), "toBlock": hex(end)}], timeout=90)
            start, cool = end + 1, 0
            time.sleep(1.0)   # publicnode bans an IP that bursts getLogs
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) or e.code >= 500:
                cool += 1
                if cool > 4:
                    if start > a:
                        raise PartialScan(out, start - 1, e)
                    raise
                print(f"      HTTP {e.code}, cooling down {30 * cool}s", flush=True)
                time.sleep(30 * cool)
                continue
            raise
        except Exception as e:
            if end - start < 200:
                if start > a:
                    raise PartialScan(out, start - 1, e)
                raise
            span = max(200, (end - start + 1) // 2)
            print(f"      range refused ({str(e)[:80]}), retrying with {span} blocks", flush=True)
    return out


def _alchemy_url(chain):
    """Alchemy endpoint from the secrets the weekly holder job already uses
    (Base is derived from the Ethereum URL, same app and key). None locally."""
    bnb = os.environ.get("ALCHEMY_BNB_URL", "").strip()
    eth = os.environ.get("ALCHEMY_ETH_URL", "").strip()
    if chain == "bnb":
        return bnb or None
    if chain == "eth":
        return eth or None
    if chain == "base":
        b = os.environ.get("ALCHEMY_BASE_URL", "").strip()
        if b:
            return b
        if "eth-mainnet.g.alchemy.com" in eth:
            return eth.replace("eth-mainnet.g.alchemy.com", "base-mainnet.g.alchemy.com")
    return None


def fetch_evm_alchemy(chain, url, win_start):
    """Whole window via alchemy_getAssetTransfers: no block-range cap, full
    history, and it never answers a throttled request with an empty list (which
    publicnode BNB was seen to do). Cheap enough to rescan all 30 days daily,
    so each run also repairs anything a keyless run missed. The key lives in the
    URL: never print it."""
    contract, dec, _ = EVM[chain]
    cache = {}
    head = int(_rpc(url, "eth_blockNumber", []), 16) - 3
    win_block = _evm_block_at(url, win_start, head, cache)
    rows, page, seen = [], None, 0
    while True:
        q = {"fromBlock": hex(win_block), "toBlock": hex(head), "contractAddresses": [contract],
             "category": ["erc20"], "withMetadata": True, "excludeZeroValue": True,
             "maxCount": "0x3e8", "order": "asc"}
        if page:
            q["pageKey"] = page
        res = _rpc(url, "alchemy_getAssetTransfers", [q], timeout=120)
        for t in res.get("transfers", []):
            seen += 1
            raw = (t.get("rawContract") or {}).get("value")
            if not raw:
                continue
            amt = int(raw, 16) / 10**dec
            if amt < THRESHOLD:
                continue
            li = (t.get("uniqueId") or "").rsplit(":", 1)[-1]
            li = int(li, 16) if li.startswith("0x") else (int(li) if li.isdigit() else 0)
            ts = (t.get("metadata") or {}).get("blockTimestamp")
            n = int(t["blockNum"], 16)
            rows.append({"id": f"{chain}:{t['hash']}:{li}", "chain": chain,
                         "ts": parse_iso(ts) if ts else _evm_block_ts(url, n, cache),
                         "amount": round(amt, 2), "from": (t.get("from") or ZERO_EVM).lower(),
                         "to": (t.get("to") or ZERO_EVM).lower(), "tx": t["hash"], "block": n})
        page = res.get("pageKey")
        if not page:
            break
    print(f"    {chain}: blocks {win_block:,} -> {head:,} via Alchemy, {seen:,} transfers, "
          f"{len(rows)} >= {THRESHOLD:,}", flush=True)
    return rows, {"cursor": head, "coverage_from": win_start, "source": "alchemy", "replace": True}


def fetch_evm(chain, state, win_start):
    contract, dec, rpcs = EVM[chain]
    last_err = None
    au = _alchemy_url(chain)
    if au:
        try:
            return fetch_evm_alchemy(chain, au, win_start)
        except Exception as e:      # message only: the URL carries the key
            last_err = e
            print(f"    {chain}: Alchemy failed ({type(e).__name__}: {str(e)[:120]}), "
                  f"falling back to public RPCs", flush=True)
    for url, span in rpcs:
        try:
            cache = {}
            head = int(_rpc(url, "eth_blockNumber", []), 16) - 3   # small reorg margin
            cur = state.get("cursor")
            # with a cursor, the daily run just continues from it (rows older than
            # the window are trimmed by time in main); skip the ~20-call search
            win_block = (cur + 1) if cur else _evm_block_at(url, win_start, head, cache)
            start = max(cur + 1, win_block) if cur else win_block
            gap = False
            depth = KEYLESS_DEPTH.get(chain)
            if depth and head - start > depth:
                if cur:
                    gap = True
                    print(f"    {chain}: cursor is {head - start:,} blocks behind, beyond the "
                          f"{depth:,} a keyless node serves reliably; blocks before "
                          f"{head - depth:,} are skipped", flush=True)
                start = head - depth
            try:
                cov = None if (cur and cur + 1 >= win_block and not gap) else _evm_block_ts(url, start, cache)
            except LookupError:
                cov = win_start
            if start <= head and cur and not _logs_ok(url, contract, start):
                raise RuntimeError(f"cursor block {start:,} is older than this node's log history")
            if start <= head and not cur and not _logs_ok(url, contract, start):
                # Public BNB/Base nodes keep logs for only part of the window
                # (publicnode BNB: ~2-4M blocks, then HTTP 403). Start at the
                # oldest block it serves; coverage fills forward from there.
                oldest = _evm_oldest_served(url, contract, start, head)
                print(f"    {chain}: {url} serves logs only from block {oldest:,}", flush=True)
                start, cov = oldest, _evm_block_ts(url, oldest, cache)
            if start > head:
                return [], {"cursor": head, "coverage_from": cov, "source": url}
            partial = None
            if (head - start + 1) > span * MAX_CALLS_PER_RUN:
                # a narrow-range fallback would take hours over a backfill: read a
                # slice now and let later runs carry on from the cursor
                partial = PartialScan([], start + span * MAX_CALLS_PER_RUN - 1, "per-run call budget")
                head = partial.last_done
            print(f"    {chain}: blocks {start:,} -> {head:,} ({head - start + 1:,}) via {url}", flush=True)
            try:
                logs = _evm_logs(url, contract, start, head, span)
                if partial:
                    print(f"    {chain}: call budget reached at block {head:,}, next run resumes", flush=True)
            except PartialScan as p:
                logs, partial = p.logs, p
                print(f"    {chain}: stopped at block {p.last_done:,} ({str(p)[:80]}); "
                      f"keeping what was read, next run resumes", flush=True)
            rows = []
            for lg in logs:
                amt = int(lg["data"], 16) / 10**dec
                if amt < THRESHOLD or lg.get("removed"):
                    continue
                n = int(lg["blockNumber"], 16)
                ts = int(lg["blockTimestamp"], 16) if lg.get("blockTimestamp") else _evm_block_ts(url, n, cache)
                rows.append({
                    "id": f"{chain}:{lg['transactionHash']}:{int(lg['logIndex'], 16)}",
                    "chain": chain, "ts": ts, "amount": round(amt, 2),
                    "from": "0x" + lg["topics"][1][-40:], "to": "0x" + lg["topics"][2][-40:],
                    "tx": lg["transactionHash"], "block": n,
                })
            print(f"    {chain}: {len(logs):,} transfers scanned, {len(rows)} >= {THRESHOLD:,}", flush=True)
            meta = {"cursor": partial.last_done if partial else head, "coverage_from": cov, "source": url}
            if partial:
                meta["partial"] = True
            return rows, meta
        except Exception as e:
            last_err = e
            print(f"    {chain}: {url} failed: {str(e)[:160]}", flush=True)
    raise RuntimeError(f"all {chain} RPCs failed: {last_err}")


# ---------------------------------------------------------------- Solana
def fetch_solana(state, win_start):
    last_err = None
    for url in SOL_RPCS:
        try:
            cur = state.get("cursor")
            sigs, before, newest = [], None, None
            reached_window_start = False
            while True:
                opts = {"limit": 1000}
                if before:
                    opts["before"] = before
                if cur:
                    opts["until"] = cur
                page = _rpc(url, "getSignaturesForAddress", [SOL_MINT, opts])
                if not page:
                    break
                newest = newest or page[0]["signature"]
                for s in page:
                    if (s.get("blockTime") or 0) < win_start:
                        reached_window_start = True
                        break
                    if s.get("err") is None:
                        sigs.append(s)
                if reached_window_start or len(page) < 1000:
                    break
                before = page[-1]["signature"]
            # A public RPC can keep far less signature history than the window. If
            # the walk ran out before the window start (and before the cursor),
            # coverage only reaches back to the oldest signature it returned.
            truncated = not reached_window_start and not cur and sigs
            print(f"    solana: {len(sigs)} new signatures via {url}"
                  + (" (history truncated)" if truncated else ""), flush=True)
            rows = []
            for i, s in enumerate(sigs):
                try:      # Solana now serves version-1 transactions; 0 is refused for those
                    tx = _rpc(url, "getTransaction", [s["signature"], {"encoding": "jsonParsed",
                                                                       "maxSupportedTransactionVersion": 1}])
                except RuntimeError as e:
                    if "version" not in str(e).lower():
                        raise
                    tx = _rpc(url, "getTransaction", [s["signature"], {"encoding": "jsonParsed",
                                                                       "maxSupportedTransactionVersion": 0}])
                time.sleep(0.5)
                if not tx or not tx.get("meta") or tx["meta"].get("err"):
                    continue
                delta = {}
                for key, sign in (("preTokenBalances", -1), ("postTokenBalances", 1)):
                    for b in tx["meta"].get(key) or []:
                        if b.get("mint") != SOL_MINT:
                            continue
                        o = b.get("owner") or f"account#{b.get('accountIndex')}"
                        delta[o] = delta.get(o, 0) + sign * int(b["uiTokenAmount"]["amount"])
                if not delta:
                    continue
                net = sum(delta.values())               # != 0 means supply changed: mint/burn
                neg = sorted((v, o) for o, v in delta.items() if v < 0)
                pos = sorted(((v, o) for o, v in delta.items() if v > 0), reverse=True)
                out_amt = -sum(v for v, _ in neg) / 10**SOL_DEC
                in_amt = sum(v for v, _ in pos) / 10**SOL_DEC
                amt = max(out_amt, in_amt)
                if amt < THRESHOLD:
                    continue
                frm = neg[0][1] if neg else "MINT"
                to = pos[0][1] if pos else "BURN"
                if net > 0 and neg:      # mint plus a move: report the mint leg
                    frm = "MINT"
                if net < 0 and pos:
                    to = "BURN"
                rows.append({"id": f"solana:{s['signature']}", "chain": "solana",
                             "ts": tx.get("blockTime") or s.get("blockTime"), "amount": round(amt, 2),
                             "from": frm, "to": to, "tx": s["signature"], "block": tx.get("slot")})
            cov = None if cur else win_start
            if truncated:
                cov = min(s.get("blockTime") or win_start for s in sigs)
            return rows, {"cursor": newest or cur, "coverage_from": cov, "source": url}
        except Exception as e:
            last_err = e
            print(f"    solana: {url} failed: {str(e)[:160]}", flush=True)
    raise RuntimeError(f"all Solana RPCs failed: {last_err}")


# ---------------------------------------------------------------- Algorand
def _algo_flatten(t, root_id, idx_path=""):
    yield t, (root_id + idx_path)
    for i, it in enumerate(t.get("inner-txns") or []):
        yield from _algo_flatten(it, root_id, f"{idx_path}/inner/{i + 1}")


def fetch_algorand(state, win_start):
    last_err = None
    raw_thr = THRESHOLD * 10**ALGO_DEC
    for base in ALGO_IDX:
        try:
            cur = state.get("cursor")
            q = {"currency-greater-than": raw_thr - 1, "limit": 1000}
            if cur:
                q["min-round"] = cur + 1
            else:
                q["after-time"] = iso(win_start)
            rows, token, current = [], None, None
            while True:
                if token:
                    q["next"] = token
                d = _get(f"{base}/v2/assets/{ALGO_ASA}/transactions?" + urllib.parse.urlencode(q))
                current = d.get("current-round", current)
                for root in d.get("transactions", []):
                    for t, tid in _algo_flatten(root, root["id"]):
                        a = t.get("asset-transfer-transaction")
                        if t.get("tx-type") != "axfer" or not a or a.get("asset-id") != ALGO_ASA:
                            continue
                        frm = a.get("sender") or t["sender"]      # clawback uses asset-sender
                        ts = root.get("round-time")
                        for amt_raw, to, suffix in ((a.get("amount", 0), a.get("receiver"), ""),
                                                    (a.get("close-amount", 0), a.get("close-to"), ":close")):
                            if not to or amt_raw < raw_thr:
                                continue
                            rows.append({"id": f"algorand:{tid}{suffix}", "chain": "algorand", "ts": ts,
                                         "amount": round(amt_raw / 10**ALGO_DEC, 2), "from": frm, "to": to,
                                         "tx": root["id"], "block": root.get("confirmed-round")})
                token = d.get("next-token")
                if not token or not d.get("transactions"):
                    break
            print(f"    algorand: {len(rows)} >= {THRESHOLD:,} via {base}", flush=True)
            return rows, {"cursor": current or cur, "coverage_from": None if cur else win_start, "source": base}
        except Exception as e:
            last_err = e
            print(f"    algorand: {base} failed: {str(e)[:160]}", flush=True)
    raise RuntimeError(f"all Algorand indexers failed: {last_err}")


# ---------------------------------------------------------------- Stellar (XDR, no SDK)
def _crc16(data):
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else crc << 1
            crc &= 0xFFFF
    return crc


def _strkey(ver, payload):
    d = bytes([ver]) + payload
    return base64.b32encode(d + struct.pack("<H", _crc16(d))).decode().rstrip("=")


def _strkey_payload(s):
    return base64.b32decode(s + "=" * (-len(s) % 8))[1:-2]


def stellar_sac_id(code, issuer):
    nid = hashlib.sha256(b"Public Global Stellar Network ; September 2015").digest()
    asset = struct.pack(">i", 1) + code.encode().ljust(4, b"\0") + struct.pack(">i", 0) + _strkey_payload(issuer)
    pre = struct.pack(">i", 8) + nid + struct.pack(">i", 1) + asset   # ENVELOPE_TYPE_CONTRACT_ID, FROM_ASSET
    return _strkey(2 << 3, hashlib.sha256(pre).digest())


class _Xdr:
    def __init__(self, b64):
        self.b, self.p = base64.b64decode(b64), 0

    def take(self, n):
        v = self.b[self.p:self.p + n]; self.p += n; return v

    def u32(self): return struct.unpack(">I", self.take(4))[0]
    def i32(self): return struct.unpack(">i", self.take(4))[0]
    def u64(self): return struct.unpack(">Q", self.take(8))[0]
    def i64(self): return struct.unpack(">q", self.take(8))[0]

    def opaque(self):
        n = self.u32(); v = self.take(n); self.take((-n) % 4); return v

    def address(self):
        t = self.i32()
        if t == 0:                      # account
            self.i32(); return _strkey(6 << 3, self.take(32))
        if t == 1:                      # contract
            return _strkey(2 << 3, self.take(32))
        if t == 2:                      # muxed account: id then ed25519
            mid = self.u64(); key = self.take(32); return _strkey(12 << 3, key + struct.pack(">Q", mid))
        if t == 3:                      # claimable balance
            self.i32(); return _strkey(1 << 3, b"\0" + self.take(32))
        if t == 4:                      # liquidity pool
            return _strkey(11 << 3, self.take(32))
        raise ValueError(f"ScAddress type {t}")

    def scval(self):
        t = self.i32()
        if t == 0: return bool(self.u32())                 # bool
        if t == 1: return None                             # void
        if t in (3,): return self.u32()
        if t in (4,): return self.i32()
        if t in (5, 7): return self.u64()
        if t in (6, 8): return self.i64()
        if t == 9: return self.u64() << 64 | self.u64()    # u128
        if t == 10:                                        # i128
            hi = self.i64(); lo = self.u64(); return (hi << 64) | lo
        if t in (13, 14, 15): return self.opaque().decode("utf-8", "replace")
        if t == 18: return self.address()
        if t == 16:                                        # vec (optional)
            return [self.scval() for _ in range(self.u32())] if self.u32() else []
        if t == 17:                                        # map (optional)
            if not self.u32(): return {}
            out = {}
            for _ in range(self.u32()):
                k = self.scval(); out[k] = self.scval()
            return out
        raise ValueError(f"ScVal type {t}")


def _stellar_amount(v):
    if isinstance(v, dict):
        v = v.get("amount", 0)
    return int(v or 0)


def fetch_stellar(state, win_start):
    sac = stellar_sac_id("RIO", STELLAR_ISSUER)
    last_err = None
    for url in STELLAR_RPCS:
        try:
            health = _rpc(url, "getHealth", {})
            oldest, latest = health["oldestLedger"], health["latestLedger"]
            cur = state.get("cursor")
            start = max(oldest + 1, (cur + 1) if cur else oldest + 1)
            coverage = None if (cur and cur + 1 >= oldest + 1) else "OLDEST"
            params = {"startLedger": start,
                      "filters": [{"type": "contract", "contractIds": [sac]}],
                      "pagination": {"limit": 1000}}
            rows, scanned, last_ledger, first_ts = [], 0, latest, None
            while True:
                res = _rpc(url, "getEvents", params, timeout=90)
                evs = res.get("events") or []
                last_ledger = res.get("latestLedger", last_ledger)
                for ev in evs:
                    scanned += 1
                    ts = parse_iso(ev["ledgerClosedAt"])
                    first_ts = first_ts or ts
                    if ts < win_start:
                        continue
                    topics = [_Xdr(t).scval() for t in ev["topic"]]
                    kind = topics[0] if topics else None
                    if kind == "transfer" and len(topics) >= 3:
                        frm, to = topics[1], topics[2]
                    elif kind == "mint" and len(topics) >= 2:
                        frm, to = "ISSUER", topics[-2] if len(topics) >= 3 else topics[1]
                    elif kind in ("burn", "clawback") and len(topics) >= 2:
                        frm, to = topics[1], "ISSUER"
                    else:
                        continue
                    amt = _stellar_amount(_Xdr(ev["value"]).scval()) / 10**STELLAR_DEC
                    if amt < THRESHOLD:
                        continue
                    rows.append({"id": f"stellar:{ev['id']}", "chain": "stellar", "ts": ts,
                                 "amount": round(amt, 2), "from": frm, "to": to, "tx": ev["txHash"],
                                 "block": ev["ledger"], "op": kind})
                if len(evs) < params["pagination"]["limit"]:
                    break
                params = {"filters": params["filters"],
                          "pagination": {"limit": 1000, "cursor": res.get("cursor") or evs[-1]["id"]}}
            cov_ts = None
            if coverage == "OLDEST":
                # time of the oldest retained ledger: ~5.5s per ledger back from now
                cov_ts = max(win_start, int(time.time()) - int((latest - start) * 5.6))
            print(f"    stellar: ledgers {start:,} -> {last_ledger:,}, {scanned} RIO events, "
                  f"{len(rows)} >= {THRESHOLD:,} via {url}", flush=True)
            return rows, {"cursor": last_ledger, "coverage_from": cov_ts, "source": url}
        except Exception as e:
            last_err = e
            print(f"    stellar: {url} failed: {str(e)[:160]}", flush=True)
    raise RuntimeError(f"all Stellar RPCs failed: {last_err}")


# ---------------------------------------------------------------- Native Realio
def native_modules():
    for lcd in NATIVE_LCDS:
        try:
            d = _get(f"{lcd}/cosmos/auth/v1beta1/module_accounts")
            return {a["base_account"]["address"]: a["name"] for a in d.get("accounts", [])
                    if a.get("base_account", {}).get("address")}
        except Exception as e:
            print(f"    native: module accounts from {lcd} failed: {str(e)[:100]}", flush=True)
    return {}


def _ario(amount_str):
    """'123ario,45arst' -> ario amount in RIO."""
    for part in (amount_str or "").split(","):
        if part.endswith(NATIVE_DENOM) and part[:-len(NATIVE_DENOM)].isdigit():
            return int(part[:-len(NATIVE_DENOM)]) / 10**NATIVE_DEC
    return 0.0


def _pb_fields(buf):
    """Minimal protobuf reader: yields (field_no, wire_type, value)."""
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(buf, i)
        elif wt == 2:
            n, i = _varint(buf, i); v = buf[i:i + n]; i += n
        elif wt == 1:
            v = buf[i:i + 8]; i += 8
        elif wt == 5:
            v = buf[i:i + 4]; i += 4
        else:
            return
        yield f, wt, v


def _varint(buf, i):
    shift = val = 0
    while True:
        b = buf[i]; i += 1
        val |= (b & 0x7F) << shift
        if not b & 0x80:
            return val, i
        shift += 7


def tx_memo(tx_b64):
    """Memo of a Cosmos Tx (Tx.body = field 1, TxBody.memo = field 2)."""
    try:
        raw = base64.b64decode(tx_b64)
        for f, wt, v in _pb_fields(raw):
            if f == 1 and wt == 2:
                for f2, wt2, v2 in _pb_fields(v):
                    if f2 == 2 and wt2 == 2:
                        return v2.decode("utf-8", "replace")
    except Exception:
        pass
    return ""


IBC_PREFIX = {"osmo": "Osmosis", "cosmos": "Cosmos Hub", "noble": "Noble", "neutron": "Neutron",
              "axelar": "Axelar", "kava": "Kava", "evmos": "Evmos", "juno": "Juno"}


def _ibc_chain(addr):
    p = (addr or "").split("1")[0]
    return IBC_PREFIX.get(p, p or "IBC")


def fetch_native(state, win_start, modules):
    st = _get(f"{NATIVE_RPC}/status")["result"]["sync_info"]
    latest_h, latest_t = int(st["latest_block_height"]), parse_iso(st["latest_block_time"])
    early_h, early_t = int(st["earliest_block_height"]), parse_iso(st["earliest_block_time"])
    bt = (latest_t - early_t) / max(1, latest_h - early_h)          # measured block time

    def h_at(ts):
        return int(latest_h - (latest_t - ts) / bt)

    exact = {}

    def resolve_times(heights):
        """Exact block times: explorer Hasura (any height), then the RPC header
        (retained heights only). Whatever is left is interpolated and flagged."""
        need = sorted(set(heights))
        for i in range(0, len(need), 200):
            chunk = need[i:i + 200]
            try:
                body = json.dumps({"query": "query($h:[bigint!]){block(where:{height:{_in:$h}}){height timestamp}}",
                                   "variables": {"h": chunk}}).encode()
                req = urllib.request.Request(NATIVE_HASURA, data=body,
                                             headers={**UA, "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                    for b in json.load(r)["data"]["block"]:
                        exact[int(b["height"])] = parse_iso(b["timestamp"])
            except Exception as e:
                print(f"    native: hasura block times failed: {str(e)[:100]}", flush=True)
        for h in need:
            if h not in exact and h >= early_h:
                try:
                    exact[h] = parse_iso(_get(f"{NATIVE_RPC}/header?height={h}")["result"]["header"]["time"])
                except Exception:
                    pass

    def ts_at(h):
        if h in exact:
            return exact[h], False
        return int(early_t - (early_h - h) * bt), True

    cur = state.get("cursor")
    win_h = max(1, h_at(win_start))
    start = max(cur + 1, win_h) if cur else win_h
    end = latest_h
    print(f"    native: heights {start:,} -> {end:,}, block time {bt:.3f}s", flush=True)
    skip = {a for a, n in modules.items() if n in NATIVE_SKIP_MODULES}
    q = urllib.parse.quote(f'"tx.height>={start} AND tx.height<={end}"')
    rows, page, total, seen = [], 1, None, 0
    while True:
        d = _get(f"{NATIVE_RPC}/tx_search?query={q}&per_page=100&page={page}&order_by=%22asc%22")["result"]
        total = int(d["total_count"])
        for t in d["txs"]:
            seen += 1
            if t["tx_result"].get("code", 0) != 0:
                continue
            ev = t["tx_result"]["events"]
            acts, ibc_out, ibc_in = {}, {}, {}
            for e in ev:
                at = {x["key"]: x["value"] for x in e["attributes"]}
                mi = at.get("msg_index")
                if e["type"] == "message" and "action" in at:
                    acts[mi] = at["action"]
                elif e["type"] == "ibc_transfer":
                    ibc_out[mi] = at.get("receiver")
                elif e["type"] == "fungible_token_packet" and at.get("sender"):
                    ibc_in[mi] = at.get("sender")
            n = 0
            for e in ev:
                if e["type"] != "transfer":
                    continue
                at = {x["key"]: x["value"] for x in e["attributes"]}
                mi = at.get("msg_index")
                if mi is None:            # tx-level fee transfer
                    continue
                n += 1
                amt = _ario(at.get("amount"))
                frm, to = at.get("sender"), at.get("recipient")
                if amt < THRESHOLD or frm in skip or to in skip:
                    continue
                act = acts.get(mi, "")
                h = int(t["height"])
                r = {"id": f"native:{t['hash']}:{mi}:{n}", "chain": "native", "ts": None,
                     "amount": round(amt, 2), "from": frm, "to": to, "tx": t["hash"], "block": h,
                     "msg": act.rsplit(".", 1)[-1]}
                if act.endswith("MsgBridgeIn"):
                    # memo "bridge_in:<bridge id>:<source-chain burn tx>" pairs the legs exactly
                    src = tx_memo(t.get("tx", "")).rsplit(":", 1)[-1].strip()
                    if src.startswith("0x") and len(src) == 66:
                        r["src_tx"] = src.lower()
                if act.endswith("MsgTransfer") and ibc_out.get(mi):
                    r["to"], r["via"] = ibc_out[mi], "ibc_out"
                if act.endswith("MsgRecvPacket") and ibc_in.get(mi):
                    r["from"], r["via"] = ibc_in[mi], "ibc_in"
                rows.append(r)
        if page * 100 >= total or not d["txs"]:
            break
        page += 1
    resolve_times(r["block"] for r in rows)
    for r in rows:
        r["ts"], est = ts_at(r["block"])
        if est:
            r["time_est"] = True
    print(f"    native: {total} txs scanned, {len(rows)} transfers >= {THRESHOLD:,}", flush=True)
    return rows, {"cursor": end, "coverage_from": None if cur else win_start, "source": NATIVE_RPC,
                  "block_time_s": round(bt, 3), "exact_time_from_height": early_h}


# ---------------------------------------------------------------- labels + classification
def build_labels(modules):
    lab = {c: {k.lower() if c in EVM else k: v for k, v in m.items()} for c, m in STATIC_LABELS.items()}
    try:
        h = json.load(open(HOLDERS, encoding="utf-8"))
    except Exception:
        h = {}
    for ex in h.get("bsc_exchanges", []):
        kind = "dex" if "dex" in ex["entity"].lower() else "exchange"
        name = "DEX pool" if kind == "dex" else ex["entity"]
        for a in ex.get("addresses", []):
            lab.setdefault("bnb", {})[a.lower()] = (name, kind)
    for ex in h.get("eth_holders", []):
        t = ex.get("type", "").lower()
        kind = "dex" if "dex" in t else ("bridge" if "bridge" in t else "exchange")
        name = {"dex": "DEX pool", "bridge": "Base bridge (escrow)"}.get(kind, ex["holder"])
        for a in ex.get("addresses", []):
            lab.setdefault("eth", {})[a.lower()] = (name, kind)
    for addr, name in modules.items():
        nice = {"bridge": ("Bridge module", "bridge"), "transfer": ("IBC module", "ibc"),
                "erc20": ("ERC-20 module", "module"), "evm": ("EVM module", "module")}.get(name)
        lab.setdefault("native", {})[addr] = nice or (f"{name} module", "module")
    return lab


def classify(rows, labels):
    for r in rows:
        c = r["chain"]
        L = labels.get(c, {})
        key = (lambda a: (a or "").lower()) if c in EVM else (lambda a: a)
        fl, tl = L.get(key(r["from"])), L.get(key(r["to"]))
        kind = "wallet"
        if c in ("bnb", "eth", "base") and r["from"] == ZERO_EVM:
            fl, kind = ("Bridge mint", "bridge"), "bridge_in"
        elif c in ("bnb", "eth", "base") and r["to"] == ZERO_EVM:
            tl, kind = ("Bridge burn", "bridge"), "bridge_out"
        elif c == "eth" and key(r["to"]) == BASE_L1_BRIDGE:
            kind = "bridge_out"
        elif c == "eth" and key(r["from"]) == BASE_L1_BRIDGE:
            kind = "bridge_in"
        elif c == "solana" and r["from"] == "MINT":
            fl, kind = ("Bridge mint", "bridge"), "bridge_in"
        elif c == "solana" and r["to"] == "BURN":
            tl, kind = ("Bridge burn", "bridge"), "bridge_out"
        elif c == "stellar" and r["from"] == "ISSUER":
            fl, kind = ("RIO issuer (mint)", "issuer"), "mint"
        elif c == "stellar" and r["to"] == "ISSUER":
            tl, kind = ("RIO issuer (burn)", "issuer"), "burn"
        elif c == "native" and r.get("msg") == "MsgBridgeOut":
            tl, kind = ("Bridge burn", "bridge"), "bridge_out"
        elif c == "native" and r.get("msg") == "MsgBridgeIn":
            fl, kind = ("Bridge mint", "bridge"), "bridge_in"
        elif r.get("via") == "ibc_out":
            tl, kind = (f"{_ibc_chain(r['to'])} (via IBC)", "ibc"), "ibc_out"
        elif r.get("via") == "ibc_in":
            fl, kind = (f"{_ibc_chain(r['from'])} (via IBC)", "ibc"), "ibc_in"
        else:
            fk, tk = (fl or (None, None))[1], (tl or (None, None))[1]
            if fk == "exchange" and tk == "exchange" and fl[0] == tl[0]:
                kind = "exchange"
            elif tk == "exchange":
                kind = "deposit"
            elif fk == "exchange":
                kind = "withdrawal"
            elif "dex" in (fk, tk):
                kind = "dex"
        r["kind"] = kind
        r["from_label"] = fl[0] if fl else None
        r["to_label"] = tl[0] if tl else None
        r.pop("pair", None)
        r.pop("pair_exact", None)
    # pair bridge legs across chains: each out with the nearest-in-time in of ~equal size
    outs = sorted((r for r in rows if r["kind"] == "bridge_out"), key=lambda r: r["ts"])
    ins = [r for r in rows if r["kind"] == "bridge_in"]
    used = set()
    # 1) exact: a native MsgBridgeIn names the EVM burn tx in its memo
    by_tx = {}
    for o in outs:
        by_tx.setdefault(o["tx"].lower(), []).append(o)
    for i in ins:
        for o in by_tx.get(i.get("src_tx") or "", []):
            if "pair" not in o and i["id"] not in used:
                used.add(i["id"])
                o["pair"], i["pair"] = i["id"], o["id"]
                o["pair_exact"] = i["pair_exact"] = True
                break
    # 2) otherwise: nearest-in-time leg of near-equal size on another chain
    for o in outs:
        if "pair" in o:
            continue
        best = None
        for i in ins:
            # an in that names its source tx is never guessed onto a different one
            if i["id"] in used or i["chain"] == o["chain"] or i.get("src_tx"):
                continue
            dt = i["ts"] - o["ts"]
            if not (-3600 <= dt <= PAIR_WINDOW_S):
                continue
            if abs(i["amount"] - o["amount"]) > PAIR_TOL * o["amount"]:
                continue
            # Ethereum <-> Base legs only pair with each other; Base has no other bridge
            if "base" in (o["chain"], i["chain"]) and {o["chain"], i["chain"]} != {"eth", "base"}:
                continue
            score = abs(dt) + abs(i["amount"] - o["amount"])
            if best is None or score < best[0]:
                best = (score, i)
        if best:
            i = best[1]
            used.add(i["id"])
            o["pair"], i["pair"] = i["id"], o["id"]
    return rows


# ---------------------------------------------------------------- main
FETCHERS = [("bnb", lambda s, w, m: fetch_evm("bnb", s, w)),
            ("eth", lambda s, w, m: fetch_evm("eth", s, w)),
            ("base", lambda s, w, m: fetch_evm("base", s, w)),
            ("solana", lambda s, w, m: fetch_solana(s, w)),
            ("algorand", lambda s, w, m: fetch_algorand(s, w)),
            ("stellar", lambda s, w, m: fetch_stellar(s, w)),
            ("native", lambda s, w, m: fetch_native(s, w, m))]


def main():
    only = set(sys.argv[1:])
    now = int(time.time())
    win_start = now - WINDOW_DAYS * 86400
    try:
        prev = json.load(open(OUT, encoding="utf-8"))
    except Exception:
        prev = {}
    prev_chains = prev.get("chains", {})
    by_id = {r["id"]: r for r in prev.get("transfers", [])}
    modules = native_modules()
    chains = {}
    for key, fn in FETCHERS:
        pst = dict(prev_chains.get(key, {}))
        if only and key not in only:
            chains[key] = pst
            continue
        t0 = time.time()
        try:
            rows, meta = fn(pst, win_start, modules)
            if meta.pop("replace", False):          # full-window rescan supersedes old rows
                by_id = {k: v for k, v in by_id.items() if v["chain"] != key}
            for r in rows:
                by_id[r["id"]] = r
            cov = meta.pop("coverage_from", None)
            if cov is None:
                cov = pst.get("coverage_from") or win_start
            status = "partial" if meta.pop("partial", False) else "ok"
            chains[key] = {**meta, "status": status, "coverage_from": max(int(cov), win_start),
                           "updated": iso(now), "seconds": round(time.time() - t0, 1)}
        except Exception as e:
            print(f"  ! {key} failed, keeping previous rows: {e}", flush=True)
            chains[key] = {**pst, "status": "stale", "error": str(e)[:200], "updated_attempt": iso(now)}
    rows = [r for r in by_id.values() if r["ts"] and r["ts"] >= win_start]
    rows.sort(key=lambda r: (-r["ts"], r["id"]))
    classify(rows, build_labels(modules))
    for c in chains.values():
        if c.get("coverage_from"):
            c["coverage_from"] = max(int(c["coverage_from"]), win_start)
    out = {
        "as_of": iso(now),
        "threshold_rio": THRESHOLD,
        "window_days": WINDOW_DAYS,
        "window_start": iso(win_start),
        "source": "Public keyless endpoints, see fetch_large_transfers.py. Labels from holders.json "
                  "and known bridge, module and treasury addresses.",
        "chains": chains,
        "transfers": rows,
    }
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, OUT)
    ok = sum(1 for c in chains.values() if c.get("status") in ("ok", "partial"))
    print(f"wrote {OUT}: {len(rows)} transfers >= {THRESHOLD:,} RIO, {ok}/{len(chains)} chains ok")
    if ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
