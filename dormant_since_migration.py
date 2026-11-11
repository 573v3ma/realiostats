#!/usr/bin/env python3
"""
One-off: how many BNB / Ethereum RIO wallets have not moved since the
30 Oct 2024 migration, and how much RIO they hold.

The migration re-issued RIO on a new contract (0x94a8...aa0, same address on
both chains) by minting each holder's balance from the zero address. So a
wallet "untouched since the migration" is one that received a migration mint
and has had NO RIO transfer in or out since. Its balance is still exactly the
migrated amount.

Method: walk the contract's full transfer history once per chain (same source
as fetch_evm_holders.py, alchemy_getAssetTransfers), mark migration mints
(from = zero address, inside the migration window), and flag every address
that shows any other transfer afterwards.

Optional --nonce: for each dormant wallet, also compare its outgoing tx count
(nonce) at the migration block with today. Nonce unchanged = the wallet has not
sent ANY transaction on that chain since (not just RIO). Needs an archive node;
Alchemy is one.

Env vars, same as the weekly job (never printed):
  ALCHEMY_BNB_URL, ALCHEMY_ETH_URL

Usage (migration days = days with 100+ zero-address mints up to --cutoff):
  python dormant_since_migration.py                 # both chains, RIO-only test
  python dormant_since_migration.py --nonce         # plus any-transaction test
  python dormant_since_migration.py --cutoff 2024-11-10
Output: prints a summary and writes dormant-since-migration.json next to this
file (addresses + amounts), which is NOT a site data file. Do not commit it.
"""
import json, os, sys, time, pickle, argparse, tempfile, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

CONTRACT = "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"
ZERO = "0x0000000000000000000000000000000000000000"
DEC = 10**18
HERE = os.path.dirname(os.path.abspath(__file__))
TIERS = [100, 1_000, 10_000, 100_000]


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for a in range(6):
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=90))
            if "error" in d:
                if any(x in str(d["error"]).lower() for x in ("rate", "limit", "many")):
                    time.sleep(2); continue
                raise RuntimeError(str(d["error"])[:200])
            return d["result"]
        except Exception:
            if a == 5:
                raise
            time.sleep(2)


def rpc_batch(url, calls):
    """calls: list of (method, params). Returns results in order. Backs off on
    Alchemy's compute-units-per-second 429s instead of failing."""
    body = json.dumps([{"jsonrpc": "2.0", "id": i, "method": m, "params": p}
                       for i, (m, p) in enumerate(calls)]).encode()
    for a in range(40):
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=120))
            if isinstance(d, dict):
                raise RuntimeError(str(d)[:200])
            d.sort(key=lambda x: x["id"])
            if any("error" in x for x in d):
                raise RuntimeError(str([x["error"] for x in d if "error" in x][:1])[:200])
            return [x["result"] for x in d]
        except Exception:
            if a == 39:
                raise
            time.sleep(min(10, 1.5 + a))


def fetch_transfers(url, chain):
    """All transfers ascending, cached in the temp dir so a rerun is instant."""
    ck = os.path.join(tempfile.gettempdir(), f"rio_transfers_{chain}.pkl")
    rows, pk = [], None
    if os.path.exists(ck):
        s = pickle.load(open(ck, "rb"))
        rows, pk = s["rows"], s["pk"]
        if s.get("done"):
            return rows
    pages = 0
    while True:
        p = {"fromBlock": "0x0", "toBlock": "latest", "contractAddresses": [CONTRACT],
             "category": ["erc20"], "excludeZeroValue": False, "maxCount": "0x3e8",
             "order": "asc", "withMetadata": True}
        if pk:
            p["pageKey"] = pk
        res = rpc(url, "alchemy_getAssetTransfers", [p])
        for t in res["transfers"]:
            rv = (t.get("rawContract") or {}).get("value")
            if not rv:
                continue
            rows.append(((t.get("from") or ZERO).lower(), (t.get("to") or ZERO).lower(),
                         int(rv, 16), int(t["blockNum"], 16),
                         ((t.get("metadata") or {}).get("blockTimestamp") or "")[:10]))
        pk = res.get("pageKey")
        pages += 1
        if pages % 25 == 0 or not pk:
            pickle.dump({"rows": rows, "pk": pk, "done": not pk}, open(ck, "wb"))
            print(f"  {chain}: {len(rows):,} transfers", file=sys.stderr)
        if not pk:
            return rows


MASS_MINT_MIN = 100   # a day with this many zero-address mints is an airdrop day


def analyse(rows, cutoff):
    # Migration mints: from zero, on a mass-mint day on/before the cutoff.
    # Odd single mints in the same window are bridge mints (burn-and-mint),
    # e.g. one 10M mint on 5 Nov 2024 on BNB, and are NOT migration.
    first_day = rows[0][4]
    mint_days = defaultdict(lambda: [0, 0])
    for f, to, v, blk, day in rows:
        if f == ZERO and day <= max(cutoff, first_day):
            mint_days[day][0] += 1; mint_days[day][1] += v
    mig_days = {d for d, (n, _) in mint_days.items() if n >= MASS_MINT_MIN}
    migrated = defaultdict(int)       # address -> migrated amount (wei)
    mig_block = 0
    touched_after = set()             # address had any non-migration transfer
    bal = defaultdict(int)
    for f, to, v, blk, day in rows:
        is_mig = (f == ZERO and day in mig_days)
        if is_mig:
            migrated[to] += v
            mig_block = max(mig_block, blk)
        else:
            if f != ZERO: touched_after.add(f)
            if to != ZERO: touched_after.add(to)
        bal[f] -= v; bal[to] += v
    dormant = {a: v for a, v in migrated.items() if a not in touched_after and v > 0}
    # sanity: a dormant wallet's balance must equal its migrated amount
    bad = [a for a, v in dormant.items() if bal[a] != v]
    return {
        "first_day": first_day, "mint_days": dict(sorted(mint_days.items())),
        "migrated": migrated, "dormant": dormant, "mig_block": mig_block,
        "mismatch": bad, "total_supply_now": sum(v for a, v in bal.items() if a != ZERO and v > 0),
    }


def nonce_check(url, addrs, mig_block):
    """Return {addr: (nonce_at_migration, nonce_now)}. Small throttled batches:
    the free Alchemy tier caps compute units per second. On a hard failure,
    returns what it has so far rather than losing the RIO-only results."""
    out, addrs, step = {}, list(addrs), 10
    try:
        for i in range(0, len(addrs), step):
            chunk = addrs[i:i + step]
            calls = []
            for a in chunk:
                calls += [("eth_getTransactionCount", [a, hex(mig_block)]),
                          ("eth_getTransactionCount", [a, "latest"])]
            res = rpc_batch(url, calls)
            for j, a in enumerate(chunk):
                out[a] = (int(res[2 * j], 16), int(res[2 * j + 1], 16))
            if (i // step) % 50 == 0:
                print(f"    nonce {i + len(chunk):,}/{len(addrs):,}", file=sys.stderr)
            time.sleep(0.25)
    except Exception as e:
        print(f"    nonce check stopped early at {len(out):,}/{len(addrs):,}: {str(e)[:150]}", file=sys.stderr)
    return out


def tiers(amounts):
    rio = [v / DEC for v in amounts]
    return {"wallets": len(rio), "rio": round(sum(rio), 2),
            **{f"gte_{t:,}": sum(1 for x in rio if x >= t) for t in TIERS},
            **{f"rio_gte_{t:,}": round(sum(x for x in rio if x >= t), 2) for t in TIERS}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cutoff", default="2024-11-06",
                    help="last day (UTC) a zero-address mint counts as a migration mint")
    ap.add_argument("--nonce", action="store_true")
    ap.add_argument("--chains", default="bnb,ethereum")
    a = ap.parse_args()
    labels = {}
    try:
        h = json.load(open(os.path.join(HERE, "holders.json")))
        for side in ("bsc_exchanges", "eth_holders"):
            for e in h.get(side, []):
                for addr in (e.get("addresses") or []):
                    labels[addr.lower()] = e.get("entity") or e.get("holder")
    except Exception:
        pass

    report = {"as_of": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
              "contract": CONTRACT, "cutoff": a.cutoff, "chains": {}}
    for chain, env in (("bnb", "ALCHEMY_BNB_URL"), ("ethereum", "ALCHEMY_ETH_URL")):
        if chain not in a.chains.split(","):
            continue
        url = os.environ.get(env, "").strip()
        if not url:
            print(f"{chain}: {env} not set, skipped", file=sys.stderr); continue
        rows = fetch_transfers(url, chain)
        r = analyse(rows, a.cutoff)
        mig, dor = r["migrated"], r["dormant"]
        print(f"\n=== {chain.upper()}  ({len(rows):,} transfers, first {r['first_day']}) ===")
        print("  zero-address mints by day up to the cutoff:")
        for d, (n, v) in r["mint_days"].items():
            print(f"    {d}  {n:>6,} mints  {v / DEC:>16,.0f} RIO")
        print(f"  migration recipients: {len(mig):,} wallets, {sum(mig.values()) / DEC:,.0f} RIO")
        t = tiers(dor.values())
        print(f"  UNTOUCHED (no RIO transfer since): {t['wallets']:,} wallets "
              f"({t['wallets'] / max(1, len(mig)):.1%}), {t['rio']:,.0f} RIO "
              f"({t['rio'] * DEC / max(1, sum(mig.values())):.1%} of migrated)")
        print("   by size: " + ", ".join(f">={k:,}: {t[f'gte_{k:,}']:,} wallets / {t[f'rio_gte_{k:,}']:,.0f} RIO" for k in TIERS))
        if r["mismatch"]:
            print(f"  WARNING: {len(r['mismatch'])} dormant wallets whose balance != migrated amount")
        top = sorted(dor.items(), key=lambda x: -x[1])[:25]
        print("  largest untouched:")
        for addr, v in top:
            print(f"    {addr}  {v / DEC:>14,.0f}  {labels.get(addr, '')}")
        ch = {"transfers": len(rows), "migration_block": r["mig_block"],
              "mint_days": {d: [n, v / DEC] for d, (n, v) in r["mint_days"].items()},
              "migration_recipients": len(mig), "migrated_rio": sum(mig.values()) / DEC,
              "rio_untouched": t, "mismatch": r["mismatch"][:50]}
        rows_out = {addr: {"rio": v / DEC, "label": labels.get(addr)} for addr, v in dor.items()}
        if a.nonce:
            big = [x for x, v in dor.items() if v >= 100 * DEC]
            print(f"  checking nonces at block {r['mig_block']:,} vs latest for {len(big):,} untouched wallets with 100+ RIO...", file=sys.stderr)
            nc = nonce_check(url, big, r["mig_block"])
            silent = [x for x, (n0, n1) in nc.items() if n0 == n1]
            ts = tiers(dor[x] for x in silent)
            print(f"  of the {len(big):,} untouched 100+ RIO wallets ({len(nc):,} checked), "
                  f"NO outgoing tx of any kind since: {ts['wallets']:,} wallets, {ts['rio']:,.0f} RIO")
            print("   by size: " + ", ".join(f">={k:,}: {ts[f'gte_{k:,}']:,} wallets / {ts[f'rio_gte_{k:,}']:,.0f} RIO" for k in TIERS))
            ch["fully_silent_100plus"] = {"checked": len(nc), "of": len(big), **ts}
            for x, (n0, n1) in nc.items():
                rows_out[x].update({"nonce_at_migration": n0, "nonce_now": n1})
        ch["wallets"] = dict(sorted(rows_out.items(), key=lambda kv: -kv[1]["rio"]))
        report["chains"][chain] = ch
    out = os.path.join(HERE, "dormant-since-migration.json")
    json.dump(report, open(out, "w"), indent=1)
    print("\nwrote", out)


if __name__ == "__main__":
    main()
