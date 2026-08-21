#!/usr/bin/env python3
"""
realiostats.com - Realio native network stats (staking yield ladder + validator health).

Keyless. Reads only public LCD endpoints, same fallback pattern as fetch_supply.py.

WHY THIS EXISTS
---------------
"What does RIO staking pay?" has at least four defensible answers and they differ
by a third. app.realio.network shows 5.27%; a delegator actually receives about
4.1-4.35%. Neither is wrong: they measure different points on the same chain of
deductions. This script computes every rung from public data so the whole ladder
can be shown at once instead of one number without its basis.

The ladder, top to bottom:

  1. mint parameter        8.00%  of UNMINTED native supply. Not a yield at all:
                                  the base is the gap to the 175M cap, not supply.
  2. official APR          5.27%  nominal annual emission / total bonded weight.
                                  This is what app.realio.network displays. It is
                                  a gross issuance yield: before community tax,
                                  and on the nominal block schedule.
  3. block-adjusted        4.67%  The mint module pays a fixed provision PER BLOCK.
                                  Realio produces blocks slower than the
                                  blocks_per_year parameter assumes, so real
                                  annual issuance is below nominal by that ratio.
                                  (Same correction fetch_supply.py already makes.)
  4. after community tax   4.58%  2% is taken off the top before distribution.
                                  This is what reaches the delegator pool.
  5. after commission  4.12-4.35% Validator commission, currently 5% to 10%.
                                  This is what actually lands in a wallet.

Rung 4 was verified empirically on 21 Aug 2026 by sampling a validator's
outstanding_rewards over a 39s window and annualising: 4.59% measured against
4.58% derived, a 0.14% difference.

MULTI-DENOM CAVEAT
------------------
Realio uses multistaking: validators are secured by RIO (ario), RST (arst) and
DSTRX (an erc20: denom) together, all at bond weight 1.0. Newly minted RIO is
shared across the WHOLE bonded base, not just the RIO part, which is the single
biggest reason the yield sits where it does. RIO is currently ~53% of that base.

The per-denom split is NOT available from /realio/multistaking/... (every route
there returns 501). It is read instead from the multistaking module account's
bank balances, which is where the bonded tokens are escrowed. Bond weight 1.0 is
inferred, not read: the three balances sum to within ~0.4% of bonded +
not_bonded, which would not hold if weights differed. assert_sane() below
re-checks that every run and flags it if it ever stops holding.

Run:  python3 fetch_network.py            # summary + append to network-history.json
      python3 fetch_network.py --json     # JSON only, no write
      python3 fetch_network.py --dry-run  # summary only, no write
"""
import json, os, re, sys, urllib.request, urllib.parse
from datetime import datetime, timezone

TIMEOUT = 20
NATIVE_CAP = 175_000_000
SECONDS_PER_YEAR = 365 * 24 * 3600

HIST_FILE = "network-history.json"
VALS_FILE = "network-validators.json"

# Same list, same order as fetch_supply.py. Keep them in sync.
NATIVE_LCDS = [
    "https://realio-api.noders.services",
    "https://rest.cosmos.directory/realio",
    "https://realio.api.m.stavr.tech",
]

# Block-time averaging window. Public LCDs prune very differently: noders serves
# only ~150 blocks of history, stavr serves far more. Try widest first and fall
# back, so a heavily pruned node still yields a usable (if noisier) figure
# rather than failing the whole run.
BLOCK_SPANS = [20_000, 5_000, 1_000, 200, 100]

DENOM_LABELS = {
    "ario": "RIO",
    "arst": "RST",
}


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "realiostats/0.1"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def _parse_cosmos_ts(t):
    """Cosmos block times can carry nanoseconds, which the stdlib parser rejects."""
    t = t.strip().replace("Z", "+00:00")
    m = re.match(r"(.*T\d\d:\d\d:\d\d)(\.\d+)?(.*)$", t)
    if m:
        t = m.group(1) + (m.group(2) or "")[:7] + (m.group(3) or "")
    return datetime.fromisoformat(t).timestamp()


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


def _atoms(x):
    """18-decimal denom -> whole tokens."""
    return int(x) / 1e18


def measure_block_time(base, flags):
    """Average seconds/block, widest window the node will serve.

    This matters more than it looks: the mint module pays a fixed provision per
    BLOCK, so real annual issuance scales with actual block production, not with
    the blocks_per_year parameter. A 12% block-rate drift is a 12% error in the
    yield if ignored.
    """
    hdr = _get(f"{base}/cosmos/base/tendermint/v1beta1/blocks/latest")["block"]["header"]
    hN, tN = int(hdr["height"]), _parse_cosmos_ts(hdr["time"])
    for span in BLOCK_SPANS:
        if hN - span < 1:
            continue
        try:
            old = _get(f"{base}/cosmos/base/tendermint/v1beta1/blocks/{hN - span}")["block"]["header"]
        except Exception:
            continue                       # pruned below this height, try narrower
        dt = tN - _parse_cosmos_ts(old["time"])
        if dt > 0:
            if span < 1_000:
                flags.append(f"block_time_short_window_{span}")
            return dt / span, span, hN
    flags.append("block_time_unavailable")
    return None, None, hN


def fetch_from(base, flags):
    """Everything the network page needs, from one LCD. Raises to trigger fallback."""
    mint = _get(f"{base}/realionetwork/mint/v1/params")["params"]
    inflation = float(mint["inflation_rate"])
    blocks_per_year = float(mint["blocks_per_year"])

    ario = _atoms(_get(f"{base}/cosmos/bank/v1beta1/supply/by_denom?denom=ario")["amount"]["amount"])
    pool = _get(f"{base}/cosmos/staking/v1beta1/pool")["pool"]
    bonded = _atoms(pool["bonded_tokens"])
    not_bonded = _atoms(pool["not_bonded_tokens"])

    sp = _get(f"{base}/cosmos/staking/v1beta1/params")["params"]
    tax = float(_get(f"{base}/cosmos/distribution/v1beta1/params")["params"]["community_tax"])

    # Multistaking pool composition, via the module account's bank balances.
    mods = _get(f"{base}/cosmos/auth/v1beta1/module_accounts")["accounts"]
    ms_addr = None
    for m in mods:
        if m.get("name") == "multistaking":
            ms_addr = (m.get("base_account") or {}).get("address") or m.get("address")
    bonded_by_denom = {}
    if ms_addr:
        for b in _get(f"{base}/cosmos/bank/v1beta1/balances/{ms_addr}?pagination.limit=50")["balances"]:
            bonded_by_denom[b["denom"]] = _atoms(b["amount"])
    else:
        flags.append("multistaking_module_not_found")

    # Active validator set.
    vs = _paginate(base, "/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED", "validators")
    vals = sorted(
        ({"moniker": (v.get("description") or {}).get("moniker", ""),
          "weight": _atoms(v["tokens"]),
          "commission": float(((v.get("commission") or {}).get("commission_rates") or {}).get("rate", 0)),
          "jailed": bool(v.get("jailed"))}
         for v in vs),
        key=lambda x: -x["weight"])

    bt, span, height = measure_block_time(base, flags)
    # A heavily pruned node (noders serves ~150 blocks) gives a noisy block time,
    # and block time drives the whole emission correction. If the window was
    # short, try the other LCDs for a wider one before settling.
    if span and span < 1_000:
        for alt in NATIVE_LCDS:
            if alt == base:
                continue
            try:
                abt, aspan, _ = measure_block_time(alt, [])
            except Exception:
                continue
            if aspan and aspan > span:
                flags[:] = [f for f in flags if not f.startswith("block_time_short_window")]
                flags.append(f"block_time_from:{alt.split('//')[-1].split('/')[0]}")
                bt, span = abt, aspan
                break

    return dict(inflation=inflation, blocks_per_year=blocks_per_year, ario=ario,
                bonded=bonded, not_bonded=not_bonded, tax=tax, sp=sp,
                bonded_by_denom=bonded_by_denom, vals=vals,
                block_time=bt, block_span=span, height=height, lcd=base)


def nakamoto(vals):
    """Validators needed to pass 1/3 of voting power, i.e. to halt the chain."""
    total = sum(v["weight"] for v in vals)
    cum = 0
    for i, v in enumerate(vals, 1):
        cum += v["weight"]
        if cum > total / 3:
            return i
    return len(vals)


def top_share(vals, n):
    total = sum(v["weight"] for v in vals)
    return 100 * sum(v["weight"] for v in vals[:n]) / total if total else None


def build(d, flags):
    inflation, ario, bonded = d["inflation"], d["ario"], d["bonded"]
    tax, vals = d["tax"], d["vals"]

    unminted = NATIVE_CAP - ario
    nominal_annual = unminted * inflation

    # The parameter's own implied block time, rather than a hardcoded 5.0s.
    assumed_bt = SECONDS_PER_YEAR / d["blocks_per_year"]
    bt = d["block_time"]
    adj = (assumed_bt / bt) if bt else 1.0
    if not bt:
        flags.append("emission_not_block_adjusted")
    adjusted_annual = nominal_annual * adj

    comms = [v["commission"] for v in vals] or [0]
    comm_min, comm_max = min(comms), max(comms)
    comm_med = sorted(comms)[len(comms) // 2]

    rung = lambda annual, keep=1.0: (annual * keep / bonded) if bonded else None
    ladder = {
        "mint_parameter":      inflation,                        # on UNMINTED, not a yield
        "official_apr":        rung(nominal_annual),             # what app.realio.network shows
        "block_adjusted":      rung(adjusted_annual),
        "after_community_tax": rung(adjusted_annual, 1 - tax),
        "after_min_commission": rung(adjusted_annual, (1 - tax) * (1 - comm_min)),
        "after_med_commission": rung(adjusted_annual, (1 - tax) * (1 - comm_med)),
        "after_max_commission": rung(adjusted_annual, (1 - tax) * (1 - comm_max)),
    }

    denoms = []
    for den, amt in sorted(d["bonded_by_denom"].items(), key=lambda kv: -kv[1]):
        denoms.append({"denom": den,
                       "label": DENOM_LABELS.get(den, "DSTRX" if den.startswith("erc20:") else den),
                       "amount": round(amt, 2),
                       "pct_of_pool": None})
    pool_total = sum(x["amount"] for x in denoms)
    for x in denoms:
        x["pct_of_pool"] = round(100 * x["amount"] / pool_total, 2) if pool_total else None

    snap = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "lcd": d["lcd"],
        "height": d["height"],
        "native_cap": NATIVE_CAP,
        "ario_supply": round(ario, 2),
        "unminted": round(unminted, 2),
        "mint": {"inflation_rate": inflation, "blocks_per_year": d["blocks_per_year"],
                 "assumed_block_time_s": round(assumed_bt, 4)},
        "block_time_s": round(bt, 4) if bt else None,
        "block_time_span": d["block_span"],
        "block_adjust_factor": round(adj, 6),
        "annual_emission_nominal": round(nominal_annual, 2),
        "annual_emission_adjusted": round(adjusted_annual, 2),
        "daily_emission_adjusted": round(adjusted_annual / 365, 2),
        "community_tax": tax,
        "staking": {
            "bonded_weight": round(bonded, 2),
            "not_bonded": round(d["not_bonded"], 2),
            "bond_denom": d["sp"].get("bond_denom"),
            "max_validators": d["sp"].get("max_validators"),
            "min_commission_rate": float(d["sp"].get("min_commission_rate", 0)),
            "unbonding_time": d["sp"].get("unbonding_time"),
            "pool_by_denom": denoms,
            "multistaking_pool_total": round(pool_total, 2),
            # Share of the multistaking pool (bonded + unbonding), which is the
            # denominator the three balances actually sum to. Deliberately not
            # divided by bonded_weight: that would mix two different totals.
            "rio_pct_of_pool": round(100 * d["bonded_by_denom"].get("ario", 0) / pool_total, 2)
                               if pool_total else None,
        },
        "validators": {
            "active": len(vals),
            "jailed_in_set": sum(1 for v in vals if v["jailed"]),
            "nakamoto_coefficient": nakamoto(vals),
            "top5_pct": round(top_share(vals, 5), 2),
            "top10_pct": round(top_share(vals, 10), 2),
            "commission_min": comm_min, "commission_median": comm_med, "commission_max": comm_max,
        },
        "yield_ladder": {k: (round(v, 6) if v is not None else None) for k, v in ladder.items()},
        "flags": flags,
    }
    return snap, vals


def assert_sane(snap, d, flags):
    """Cheap invariants. A broken assumption should surface as a flag, never as a
    confident wrong number on the page."""
    s = snap["staking"]
    pool_total = sum(x["amount"] for x in s["pool_by_denom"])
    staked = s["bonded_weight"] + s["not_bonded"]
    if pool_total and staked:
        delta = abs(pool_total - staked) / staked
        # Bond weight 1.0 across denoms is inferred from this identity holding.
        if delta > 0.02:
            flags.append(f"multistaking_pool_mismatch_{delta:.3%}")
        snap["staking"]["pool_vs_staked_delta_pct"] = round(100 * delta, 3)
    if snap["ario_supply"] > NATIVE_CAP:
        flags.append("ario_supply_above_cap")
    y = snap["yield_ladder"]
    order = ["official_apr", "block_adjusted", "after_community_tax", "after_min_commission"]
    vals = [y[k] for k in order if y.get(k) is not None]
    if vals != sorted(vals, reverse=True):
        flags.append("yield_ladder_not_monotonic")
    if snap["validators"]["active"] < 10:
        flags.append("validator_set_suspiciously_small")


def summary(s):
    p = lambda x: "n/a" if x is None else f"{x*100:.2f}%"
    n = lambda x: f"{x:,.0f}"
    y = s["yield_ladder"]
    print(f"\nRealio network  ·  height {s['height']}  ·  {s['lcd']}")
    print(f"  native supply {n(s['ario_supply'])} of {n(s['native_cap'])} cap"
          f"  ·  unminted {n(s['unminted'])}")
    print(f"  block time {s['block_time_s']}s vs {s['mint']['assumed_block_time_s']}s assumed"
          f"  (x{s['block_adjust_factor']:.4f}, {s['block_time_span']} blocks)")
    print(f"  emission {n(s['annual_emission_nominal'])}/yr nominal"
          f"  ->  {n(s['annual_emission_adjusted'])}/yr real  ({n(s['daily_emission_adjusted'])}/day)")
    print(f"\n  Yield ladder")
    print(f"    mint parameter        {p(y['mint_parameter'])}   (of unminted, not a yield)")
    print(f"    official APR          {p(y['official_apr'])}   nominal / bonded weight")
    print(f"    block-adjusted        {p(y['block_adjusted'])}")
    print(f"    after {s['community_tax']*100:.0f}% community tax {p(y['after_community_tax'])}")
    print(f"    after commission      {p(y['after_max_commission'])} to {p(y['after_min_commission'])}"
          f"   (median {p(y['after_med_commission'])})")
    st = s["staking"]
    print(f"\n  Bonded weight {n(st['bonded_weight'])}"
          f"  ·  multistaking pool {n(st['multistaking_pool_total'])}"
          f"  ·  RIO is {st['rio_pct_of_pool']}% of the pool")
    for x in st["pool_by_denom"]:
        print(f"    {x['label']:<6} {n(x['amount']):>14}   {x['pct_of_pool']:>5}%")
    v = s["validators"]
    print(f"\n  Validators {v['active']} active of {st['max_validators']} slots"
          f"  ·  Nakamoto {v['nakamoto_coefficient']}"
          f"  ·  top10 {v['top10_pct']}%"
          f"  ·  commission {v['commission_min']*100:.0f}-{v['commission_max']*100:.0f}%")
    if s["flags"]:
        print(f"\n  FLAGS: {', '.join(s['flags'])}")
    print()


def main():
    args = set(sys.argv[1:])
    flags = []
    last = None
    for base in NATIVE_LCDS:
        try:
            d = fetch_from(base, flags)
            break
        except Exception as e:
            flags.append(f"lcd_failed:{base.split('//')[-1].split('/')[0]}")
            last = e
    else:
        print(f"ERROR: every native LCD failed. Last: {last}", file=sys.stderr)
        sys.exit(1)

    snap, vals = build(d, flags)
    assert_sane(snap, d, flags)
    snap["flags"] = flags

    if "--json" in args:
        print(json.dumps(snap, indent=2))
        return
    summary(snap)
    if "--dry-run" in args:
        return

    hist = []
    if os.path.exists(HIST_FILE):
        with open(HIST_FILE) as f:
            hist = json.load(f)
    # One row per UTC day; a re-run on the same day replaces that day's row
    # rather than appending a duplicate.
    day = snap["ts"][:10]
    hist = [r for r in hist if r.get("ts", "")[:10] != day]
    hist.append(snap)
    hist.sort(key=lambda r: r["ts"])
    with open(HIST_FILE, "w") as f:
        json.dump(hist, f, indent=1)

    with open(VALS_FILE, "w") as f:
        json.dump({"as_of": snap["ts"], "height": snap["height"],
                   "source": "cosmos/staking/v1beta1/validators (BOND_STATUS_BONDED)",
                   "bonded_weight": snap["staking"]["bonded_weight"],
                   "validators": [{"moniker": v["moniker"], "weight": round(v["weight"], 2),
                                   "commission": v["commission"], "jailed": v["jailed"]}
                                  for v in vals]}, f, indent=1)
    print(f"wrote {HIST_FILE} ({len(hist)} rows) and {VALS_FILE} ({len(vals)} validators)")


if __name__ == "__main__":
    main()
