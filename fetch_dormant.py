#!/usr/bin/env python3
"""
Weekly: RIO on BNB Chain and Ethereum that has never moved since the
30 Oct 2024 migration. Writes dormant-supply.json for the holders page.

The migration re-issued RIO on a new contract (0x94a8...aa0, same address on
both chains) by minting every holder's balance from the zero address. A wallet
"never moved" received a migration mint and has had no RIO transfer in or out
since, so it still holds exactly what it was migrated.

Two measures per chain:
  * never_moved: from the contract's full transfer history (same Alchemy walk
    as fetch_evm_holders.py). Exact, and reconstructable month by month, so
    it ships with a monthly history back to the migration.
  * silent ("Dead Wallets" on the site): of the never-moved wallets holding
    100+ RIO, those that have sent no transaction of any kind since the
    migration on BOTH BNB Chain and Ethereum (outgoing nonce at each chain's
    migration block equals today's; same address on both chains). Needs an archive read per wallet, so it is
    counted forward only, one point per run.

A nonce only ever goes up, so a wallet that has sent once is never silent
again. The script keeps the nonces it has read, and the wallets known to have
moved, in .cache/dormant-nonce.json (restored by the workflow from the Actions
cache, never committed, since it is an address list). After the first run each
week only re-reads today's nonce for wallets that were still silent.

The site file holds totals only, no addresses.

Env vars, never printed: ALCHEMY_BNB_URL, ALCHEMY_ETH_URL. A chain whose URL is
unset, or whose run fails, keeps its previous value.
"""
import json, os, sys, time
from collections import defaultdict
from datetime import datetime, timezone

from dormant_since_migration import fetch_transfers, analyse, rpc_batch, DEC, ZERO

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "dormant-supply.json")
CACHE = os.path.join(HERE, ".cache", "dormant-nonce.json")
CUTOFF = "2024-11-06"      # last day a mass zero-address mint counts as migration
SILENT_MIN = 100 * DEC     # nonce check only for wallets holding 100+ RIO
CALLS_PER_BATCH = 20


def months_from(start, end):
    y, m = map(int, start.split("-")); ey, em = map(int, end.split("-"))
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out


def first_touch(rows, migrated, mig_days):
    """Day each migrated wallet first moved RIO (any non-migration transfer)."""
    ft = {}
    for f, to, v, blk, day in rows:
        if f == ZERO and day in mig_days:
            continue
        for a in (f, to):
            if a in migrated and a not in ft:
                ft[a] = day
    return ft


def history(migrated, ft):
    """Month-end count and RIO of wallets that had not moved yet."""
    now = datetime.now(timezone.utc).strftime("%Y-%m")
    moved_by = defaultdict(lambda: [0, 0])
    for a, d in ft.items():
        moved_by[d[:7]][0] += 1
        moved_by[d[:7]][1] += migrated[a]
    left_n = sum(1 for v in migrated.values() if v > 0)
    left_v = sum(v for v in migrated.values() if v > 0)
    out = []
    for m in months_from("2024-10", now):
        n, v = moved_by.get(m, (0, 0))
        left_n -= n; left_v -= v
        out.append({"month": m, "wallets": left_n, "rio": round(left_v / DEC)})
    return out


def summary(amounts):
    a = list(amounts)
    big = [v for v in a if v >= 100 * DEC]
    whale = [v for v in a if v >= 10_000 * DEC]
    return {"wallets": len(a), "rio": round(sum(a) / DEC),
            "gte_100": {"wallets": len(big), "rio": round(sum(big) / DEC)},
            "gte_10k": {"wallets": len(whale), "rio": round(sum(whale) / DEC)}}


def silent_check(url, chain, cands, mig_block, cache):
    """cands: {addr: wei}. Returns (silent addr list, complete?)."""
    c = cache.setdefault(chain, {})
    if c.get("mig_block") != mig_block:
        c.clear(); c["mig_block"] = mig_block
    n0 = c.setdefault("n0", {}); moved = set(c.get("moved", []))
    todo = [a for a in cands if a not in moved]
    calls, keys = [], []
    for a in todo:
        if a not in n0:
            calls.append(("eth_getTransactionCount", [a, hex(mig_block)])); keys.append((a, "n0"))
        calls.append(("eth_getTransactionCount", [a, "latest"])); keys.append((a, "now"))
    now, done = {}, True
    print(f"  {chain}: nonce reads for {len(todo):,} of {len(cands):,} wallets "
          f"({len(calls):,} calls, {len(moved):,} already known to have moved)", file=sys.stderr)
    try:
        for i in range(0, len(calls), CALLS_PER_BATCH):
            res = rpc_batch(url, calls[i:i + CALLS_PER_BATCH])
            for (a, k), r in zip(keys[i:i + CALLS_PER_BATCH], res):
                if k == "n0": n0[a] = int(r, 16)
                else: now[a] = int(r, 16)
            if (i // CALLS_PER_BATCH) % 100 == 0:
                print(f"    {i + CALLS_PER_BATCH:,}/{len(calls):,}", file=sys.stderr)
            time.sleep(0.25)
    except Exception as e:
        done = False
        print(f"  {chain}: nonce reads stopped early: {str(e)[:150]}", file=sys.stderr)
    for a, n in now.items():
        if a in n0 and n != n0[a]:
            moved.add(a)
    c["moved"] = sorted(moved)
    silent = [a for a in cands if a in now and a in n0 and now[a] == n0[a]]
    return silent, done and len(now) == len(todo)


def main():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        prev = json.load(open(OUT))
    except Exception:
        prev = {}
    try:
        cache = json.load(open(CACHE))
    except Exception:
        cache = {}
    chains = prev.get("chains") or {}
    urls = {"bnb": os.environ.get("ALCHEMY_BNB_URL", "").strip(),
            "ethereum": os.environ.get("ALCHEMY_ETH_URL", "").strip()}
    work = {}   # chain -> (ch, dor, own-chain silent list or None)

    # Phase 1, per chain: never-moved totals and history, then the wallet's own
    # chain nonce check for never-moved wallets holding 100+ RIO.
    for chain, url in urls.items():
        if not url:
            print(f"{chain}: URL unset, keeping previous value", file=sys.stderr)
            continue
        try:
            rows = fetch_transfers(url, chain)
            r = analyse(rows, CUTOFF)
            mig_days = {d for d, (n, _) in r["mint_days"].items() if n >= 100}
            migrated = {a: v for a, v in r["migrated"].items() if v > 0}
            dor = r["dormant"]
            ft = first_touch(rows, migrated, mig_days)
            ch = {"migration_days": sorted(mig_days), "migration_block": r["mig_block"],
                  "recipients": len(migrated), "migrated_rio": round(sum(migrated.values()) / DEC),
                  "never_moved": summary(dor.values()), "history": history(migrated, ft)}
            last = ch["history"][-1]
            if last["wallets"] != ch["never_moved"]["wallets"]:
                print(f"::warning::{chain}: history end {last['wallets']} != never_moved "
                      f"{ch['never_moved']['wallets']}", file=sys.stderr)
            if r["mismatch"]:
                print(f"::warning::{chain}: {len(r['mismatch'])} never-moved wallets whose balance "
                      "differs from the migrated amount", file=sys.stderr)
            cands = {a: v for a, v in dor.items() if v >= SILENT_MIN}
            silent, complete = silent_check(url, chain, cands, r["mig_block"], cache)
            work[chain] = (ch, dor, silent if complete else None)
        except Exception as e:
            print(f"::error::{chain}: FAILED ({type(e).__name__}: {str(e)[:200]}), keeping previous value",
                  file=sys.stderr)

    # Phase 2: a dead wallet must also be silent on the OTHER chain. The same
    # address exists on BNB and Ethereum, so a wallet whose RIO sits on BNB is
    # only dead if it has sent nothing on Ethereum since that chain's migration
    # block either. Needs both chains from this run; otherwise the last
    # complete reading is kept.
    for chain, (ch, dor, silent) in work.items():
        other = "ethereum" if chain == "bnb" else "bnb"
        old = chains.get(chain) or {}
        dead, complete = None, False
        if silent is not None and other in work:
            oblk = work[other][0]["migration_block"]
            osil, ocomplete = silent_check(urls[other], other, {a: dor[a] for a in silent}, oblk, cache)
            if ocomplete:
                dead, complete = osil, True
        # History is only kept while the definition is the same (both chains).
        sh = [p for p in (old.get("silent_history") or [])
              if p.get("date") != today and p.get("scope") == "bnb+ethereum"]
        if complete:
            s = summary(dor[a] for a in dead)
            ch["silent"] = {"as_of": today, "scope": "bnb+ethereum", "candidates": len(silent),
                            "wallets": s["wallets"], "rio": s["rio"], "gte_10k": s["gte_10k"]}
            sh.append({"date": today, "scope": "bnb+ethereum", "wallets": s["wallets"], "rio": s["rio"]})
        else:
            o = old.get("silent")
            ch["silent"] = o if (o and o.get("scope") == "bnb+ethereum") else None
            print(f"::warning::{chain}: dead-wallet check incomplete, kept the previous reading",
                  file=sys.stderr)
        ch["silent_history"] = sh
        chains[chain] = ch
        nm = ch["never_moved"]
        print(f"{chain}: {ch['recipients']:,} migrated wallets, never moved {nm['wallets']:,} "
              f"/ {nm['rio']:,} RIO; silent on own chain: "
              + (f"{len(silent):,}" if silent is not None else "n/a") + "; dead on both chains: "
              + (f"{ch['silent']['wallets']:,} / {ch['silent']['rio']:,} RIO" if ch.get("silent") else "n/a"))

    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    json.dump(cache, open(CACHE, "w"))
    out = {"as_of": today,
           "source": "Full ERC-20 transfer history of 0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0 via "
                     "Alchemy getAssetTransfers; migration mints are the mass zero-address mints of "
                     "30-31 Oct 2024; dead (silent) = outgoing nonce unchanged since the migration block "
                     "on both BNB Chain and Ethereum.",
           "chains": chains}
    json.dump(out, open(OUT, "w"), indent=1)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
