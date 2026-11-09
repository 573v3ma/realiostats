#!/usr/bin/env python3
"""
realiostats.com - long daily price history for the price indicators

Writes price-history.json: every CLOSED daily candle of RIO-USDT on KuCoin since
the pair's history starts (26 April 2024), as compact rows

    [date, open, high, low, close, volume_rio, turnover_usd]

The home page draws its 1Y chart from this file and computes the indicators
from it (moving averages, RSI, Bollinger bands, VWAP, daily range), and the
methodology page re-runs the indicator backtest on it in the browser.

WHY KUCOIN AND NOT COINGECKO
----------------------------
CoinGecko's older RIO history is wrong: from February to 27 March 2026 it shows
$0.20-0.25 on days the market traded at $0.03-0.10. KuCoin's own candles do not
have that problem. Checked 9 Nov 2026 against all 105 of the site's daily
snapshots: median difference -0.3%, and every snapshot sat inside that day's
KuCoin high-low range. KuCoin is one venue, not the whole market, so the volume
columns are KuCoin's alone; the price tracks the aggregate within a few percent.

WHY CLOSED CANDLES ONLY
-----------------------
KuCoin's newest candle is the day in progress (about 6 hours old when the daily
Action runs). An indicator computed on a partial day would move all day, so it
is dropped here and the browser adds the live price as today's provisional
close instead.

The file is REGENERATED each run, not appended: exchange data is third-party and
must stay out of the append-only supply record (same reasoning as
fetch_volume.py). Informational only; never feeds the supply-integrity checks.

NO CORS: api.kucoin.com sends no Access-Control-Allow-Origin, so this runs
server-side in the daily Action. Keyless, stdlib only.

Run:  python3 fetch_price_history.py
"""
import json, os, sys, time, urllib.request
from datetime import datetime, timezone

SYMBOL = "RIO-USDT"
START = 1713484800            # 19 Apr 2024, a week before the first candle
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "price-history.json")
TIMEOUT = 30
DAY = 86400
CHUNK = 1500 * DAY            # KuCoin returns at most 1,500 candles per call


def _get(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "realiostats/0.1"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                j = json.load(r)
            if j.get("code") != "200000":
                raise RuntimeError(f"KuCoin code {j.get('code')}: {j.get('msg')}")
            return j["data"]
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))


def fetch():
    now = int(time.time())
    rows, cursor = {}, START
    while cursor < now:
        end = min(cursor + CHUNK, now)
        url = (f"https://api.kucoin.com/api/v1/market/candles"
               f"?type=1day&symbol={SYMBOL}&startAt={cursor}&endAt={end}")
        for c in _get(url):
            rows[int(c[0])] = c       # time, open, close, high, low, volume, turnover
        cursor = end
    return rows, now


def main():
    try:
        rows, now = fetch()
    except Exception as e:
        print(f"KuCoin fetch failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
    days = []
    for t in sorted(rows):
        if t + DAY > now:             # the day in progress: not closed yet
            continue
        _, o, c, h, l, v, q = rows[t]
        days.append([datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d"),
                     float(o), float(h), float(l), float(c),
                     round(float(v)), round(float(q), 2)])
    if len(days) < 400:
        print(f"only {len(days)} closed days returned, refusing to overwrite", file=sys.stderr)
        sys.exit(1)
    # a missing day would skew every rolling window, so say so loudly
    gaps = [(a[0], b[0]) for a, b in zip(days, days[1:])
            if (datetime.fromisoformat(b[0]) - datetime.fromisoformat(a[0])).days != 1]
    out = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "kucoin",
        "symbol": SYMBOL,
        "note": ("Closed daily candles from KuCoin, one venue. Price tracks the "
                 "aggregate within a few percent; volume is KuCoin's only. "
                 "Informational; not used by the supply-integrity checks."),
        "columns": ["date", "open", "high", "low", "close", "volume_rio", "turnover_usd"],
        "gaps": gaps,
        "days": days,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"price-history.json: {len(days)} days, {days[0][0]} to {days[-1][0]}, "
          f"last close ${days[-1][4]}, gaps {len(gaps)}")


if __name__ == "__main__":
    main()
