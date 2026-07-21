#!/usr/bin/env python3
"""
realiostats.com - 24h trading volume history (informational, third-party)

Writes volume-history.json: a rolling 30-day daily series of RIO's reported
24h trading volume, plus a like-for-like 24h change.

WHY THIS IS A SEPARATE FILE FROM supply-history.json
----------------------------------------------------
supply-history.json is our own measurement: every row was read from chain by us
at that moment, and its git history is the audit trail. Volume is EXCHANGE-
REPORTED data fetched from an aggregator, and this file is REGENERATED each run
rather than appended. Mixing backfilled third-party numbers into the append-only
supply record would corrupt the one property that makes it trustworthy. Keep
them separate.

Volume never feeds the supply-integrity checks. It is on the site for
convenience, so nobody has to open CoinGecko to see it.

THE ROLLING-WINDOW TRAP
-----------------------
CoinGecko's total_volumes is a TRAILING 24h figure sampled hourly, not a set of
daily buckets. It climbs and falls through the day as the window slides (21 Jul
2026 ran $198K at 04:01 to $243K at 14:26, +23% in ten hours). So:

  * the daily series takes the LAST sample of each UTC day, giving a consistent
    end-of-day reading for every point;
  * the headline change compares the newest sample against the sample closest to
    exactly 24h earlier, so both sides cover the same window length.

Sampling at inconsistent times of day would invent trends that are really just
the window sliding.

NO CORS
-------
api.coingecko.com sends no Access-Control-Allow-Origin, so the browser cannot
call it. This must run server-side (it does, in the daily Action).

Run:  python3 fetch_volume.py
"""
import json, os, sys, urllib.request
from datetime import datetime, timezone, timedelta

COIN = "realio-network"
DAYS = 30
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "volume-history.json")
TIMEOUT = 30


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "realiostats/0.1"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def fetch_series():
    url = (f"https://api.coingecko.com/api/v3/coins/{COIN}/market_chart"
           f"?vs_currency=usd&days={DAYS}")
    pts = _get(url).get("total_volumes", [])
    return [(int(ts), float(v)) for ts, v in pts if v is not None]


def to_daily(pts):
    """Last sample of each UTC day -> one consistent reading per day."""
    by_day = {}
    for ts, v in pts:
        d = datetime.fromtimestamp(ts / 1000, timezone.utc).strftime("%Y-%m-%d")
        if d not in by_day or ts > by_day[d][0]:
            by_day[d] = (ts, v)
    return [{"date": d, "volume_usd": round(by_day[d][1], 2)} for d in sorted(by_day)]


def change_24h(pts):
    """Newest sample vs the sample closest to exactly 24h earlier."""
    if len(pts) < 2:
        return None, None
    ts_new, v_new = pts[-1]
    target = ts_new - 86_400_000
    ts_old, v_old = min(pts[:-1], key=lambda p: abs(p[0] - target))
    # refuse if the nearest match is more than 3h off the 24h mark
    if abs(ts_old - target) > 3 * 3_600_000 or not v_old:
        return v_new, None
    return v_new, round((v_new - v_old) / v_old * 100, 2)


def main():
    try:
        pts = fetch_series()
    except Exception as e:
        print(f"volume fetch failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
    if len(pts) < 2:
        print("volume fetch returned too few points", file=sys.stderr)
        sys.exit(1)

    daily = to_daily(pts)
    latest, pct = change_24h(pts)
    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "coingecko",
        "note": "Exchange-reported 24h volume. Informational only; not used by the supply-integrity checks.",
        "latest_usd": round(latest, 2) if latest else None,
        "change_24h_pct": pct,
        "daily": daily[-DAYS:],
    }
    json.dump(out, open(OUT, "w"), indent=2)
    arrow = "n/a" if pct is None else f"{pct:+.2f}%"
    print(f"volume-history.json: {len(out['daily'])} days, "
          f"latest ${out['latest_usd']:,.0f}, 24h change {arrow}")


if __name__ == "__main__":
    main()
