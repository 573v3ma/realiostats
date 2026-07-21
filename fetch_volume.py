#!/usr/bin/env python3
"""
realiostats.com - market history (informational, third-party)

Writes volume-history.json: a rolling 30-day daily series of RIO's reported 24h
trading volume AND its price, each with a like-for-like 24h change.

NAMING NOTE: the file and script are still called "volume" for historical
reasons; they now carry price as well. Renaming would mean editing the workflow
that lists both artefacts by name, so the name is left alone deliberately.

WHY THIS IS A SEPARATE FILE FROM supply-history.json
----------------------------------------------------
supply-history.json is our own measurement: every row was read from chain by us
at that moment, and its git history is the audit trail. Volume and price are
EXCHANGE-REPORTED data fetched from an aggregator, and this file is REGENERATED
each run rather than appended. Mixing backfilled third-party numbers into the
append-only supply record would corrupt the one property that makes it
trustworthy. Keep them separate.

Neither volume nor price feeds the supply-integrity checks.

THE ROLLING-WINDOW TRAP (volume only)
-------------------------------------
CoinGecko's total_volumes is a TRAILING 24h figure sampled hourly, not a set of
daily buckets. It climbs and falls through the day as the window slides (21 Jul
2026 ran $198K at 04:01 to $243K at 14:26, +23% in ten hours). So:

  * the daily series takes the LAST sample of each UTC day, giving a consistent
    end-of-day reading for every point;
  * the headline change compares the newest sample against the sample closest to
    exactly 24h earlier, so both sides cover the same window length.

Sampling at inconsistent times of day would invent trends that are really just
the window sliding. Price is a spot value so it does not have this problem, but
it is resampled the same way for consistency.

NO CORS
-------
api.coingecko.com sends no Access-Control-Allow-Origin, so the browser cannot
call it. This must run server-side (it does, in the daily Action).

Run:  python3 fetch_volume.py
"""
import json, os, sys, urllib.request
from datetime import datetime, timezone

COIN = "realio-network"
DAYS = 30
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "volume-history.json")
TIMEOUT = 30


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "realiostats/0.1"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def fetch_chart():
    url = (f"https://api.coingecko.com/api/v3/coins/{COIN}/market_chart"
           f"?vs_currency=usd&days={DAYS}")
    d = _get(url)
    clean = lambda k: [(int(ts), float(v)) for ts, v in d.get(k, []) if v is not None]
    return clean("total_volumes"), clean("prices")


def to_daily(pts, key):
    """Last sample of each UTC day -> one consistent reading per day."""
    by_day = {}
    for ts, v in pts:
        day = datetime.fromtimestamp(ts / 1000, timezone.utc).strftime("%Y-%m-%d")
        if day not in by_day or ts > by_day[day][0]:
            by_day[day] = (ts, v)
    return [{"date": d, key: round(by_day[d][1], 8)} for d in sorted(by_day)]


def change_24h(pts):
    """Newest sample vs the sample closest to exactly 24h earlier."""
    if len(pts) < 2:
        return (pts[-1][1] if pts else None), None
    ts_new, v_new = pts[-1]
    target = ts_new - 86_400_000
    ts_old, v_old = min(pts[:-1], key=lambda p: abs(p[0] - target))
    # refuse if the nearest match is more than 3h off the 24h mark
    if abs(ts_old - target) > 3 * 3_600_000 or not v_old:
        return v_new, None
    return v_new, round((v_new - v_old) / v_old * 100, 2)


def main():
    try:
        vol_pts, price_pts = fetch_chart()
    except Exception as e:
        print(f"market fetch failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
    if len(vol_pts) < 2:
        print("market fetch returned too few points", file=sys.stderr)
        sys.exit(1)

    vol_latest, vol_pct = change_24h(vol_pts)
    px_latest, px_pct = change_24h(price_pts)

    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "coingecko",
        "note": ("Exchange-reported 24h volume and price. Informational only; "
                 "not used by the supply-integrity checks."),
        "latest_usd": round(vol_latest, 2) if vol_latest else None,
        "change_24h_pct": vol_pct,
        "daily": to_daily(vol_pts, "volume_usd")[-DAYS:],
        "price_latest_usd": round(px_latest, 8) if px_latest else None,
        "price_change_24h_pct": px_pct,
        "price_daily": to_daily(price_pts, "price_usd")[-DAYS:],
    }
    json.dump(out, open(OUT, "w"), indent=2)
    fv = "n/a" if vol_pct is None else f"{vol_pct:+.2f}%"
    fp = "n/a" if px_pct is None else f"{px_pct:+.2f}%"
    print(f"volume-history.json: {len(out['daily'])} days | "
          f"volume ${out['latest_usd']:,.0f} ({fv}) | "
          f"price ${out['price_latest_usd']:.5f} ({fp})")


if __name__ == "__main__":
    main()
