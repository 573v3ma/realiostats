/* realiostats overview, bento layout (Nov 2026).

   The overview loads the supply, network, news, RWA and sentiment scripts
   unchanged (core.js summary mode); they fill the ids they share with their full
   pages. This file only fills the cards that are new to the overview, and it
   computes them with the same shared functions those pages use (stakeFlow from
   network.js, computeFloat from core.js, computeObserved and CHAINS from
   supply.js), so a figure here can never drift from the page it links to.
   All text goes in via textContent or fixed markup; data values are numbers. */
(function(){
  const $ = id => document.getElementById(id);
  const getJ = u => fetch(u, {cache: "no-store"}).then(r => r.ok ? r.json() : null).catch(() => null);
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const pct1 = n => (Math.abs(n) + 1e-9).toFixed(1) + "%";
  const short = a => a && a.length > 16 ? a.slice(0, 6) + "…" + a.slice(-4) : (a || "");
  const signM = n => (n > 0 ? "+" : n < 0 ? "−" : "") + fmtM(M(Math.abs(n)));

  /* ---------- price chart ----------
     7D to 90D are plotted from CoinGecko's daily price history (no missing
     days), the same source as the live price above it. Its older history is
     not trustworthy for RIO: from February to 27 March 2026 it shows
     $0.20-0.25 on days the market traded at $0.03-0.10 (community quotes in
     the Realio Telegram groups agree with the lower figures), so CoinGecko is
     never asked for more than 92 days. Each CoinGecko day that also has a site
     snapshot is cross-checked against it, and a day more than GUARD off is
     replaced by the snapshot price (normal disagreement is a few percent:
     daily close versus a midday reading).
     The 1Y range, the averages drawn over the line and the "Where the price
     sits" card come from price-history.json instead: KuCoin's closed daily
     candles since April 2024, which match the snapshots (see indicators.js).
     1Y joins KuCoin's closes onto the front of the CoinGecko series, so its
     right-hand end is the same live line as the shorter ranges.
     Until CoinGecko answers, or if it cannot be reached, the KuCoin closes and
     the snapshots are drawn, gaps bridged with a dashed segment. */
  let PRICE_PTS = [], RANGE = "90", PRICE_SRC = "snapshots";
  let CG_RAW = null, SNAP_DAY = null, HIST = null;
  let OV_ON = true;
  try { OV_ON = localStorage.getItem("rs-ind-ov") !== "0"; } catch(e){}
  const GUARD = 0.35;
  const dayKey = t => new Date(t).toISOString().slice(0, 10);
  function rebuildPrices(){
    if(!CG_RAW) return;
    PRICE_PTS = CG_RAW.map(([t, v]) => {
      const s = SNAP_DAY && SNAP_DAY[dayKey(t)];
      return toPt(t, s && Math.abs(v / s - 1) > GUARD ? s : v);
    });
    PRICE_SRC = "coingecko";
    drawPrice();
    renderIndicators();
  }
  const toPt = (t, v) => { const d = new Date(t); return {t, v, d: d.getUTCDate() + " " + MON[d.getUTCMonth()] + (d.getUTCFullYear() !== new Date().getUTCFullYear() ? " " + d.getUTCFullYear() : "")}; };
  // The history is kept in this browser for FRESH_H hours, so repeat visits do
  // not call CoinGecko again, and a copy up to STALE_D days old still draws the
  // chart when CoinGecko is rate limiting this visitor (its free API answers a
  // blocked request with no CORS header, which reads as a failed fetch).
  const CACHE_KEY = "rs-price-hist-v2", FRESH_H = 6, STALE_D = 7;
  try { localStorage.removeItem("rs-price-hist-v1"); } catch(e){}   // the old one-year copy
  const readCache = () => { try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); return c && Array.isArray(c.prices) ? c : null; } catch(e){ return null; } };
  const usePrices = p => {
    p = (p || []).filter(x => Array.isArray(x) && x[1] > 0);
    if(p.length < 30) return false;
    CG_RAW = p;
    rebuildPrices();
    return true;
  };
  function loadPriceHistory(){
    const cached = readCache();
    const age = cached ? Date.now() - cached.ts : Infinity;
    if(age < FRESH_H * 36e5 && usePrices(cached.prices)) return Promise.resolve();
    return fetch("https://api.coingecko.com/api/v3/coins/realio-network/market_chart?vs_currency=usd&days=92&interval=daily", {cache: "no-store"})
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if(j && usePrices(j.prices)){
          try { localStorage.setItem(CACHE_KEY, JSON.stringify({ts: Date.now(), prices: j.prices})); } catch(e){}
          return;
        }
        throw new Error("no history");
      })
      .catch(() => { if(cached && age < STALE_D * 864e5) usePrices(cached.prices); });
  }
  // The newest price we hold, passed to the indicators as today's provisional close.
  const livePt = () => PRICE_PTS.length ? PRICE_PTS[PRICE_PTS.length - 1] : null;
  // KuCoin closes in front of the newer series: before CoinGecko's first day,
  // or (snapshot fallback) before the first snapshot after KuCoin's last close.
  function longPts(){
    if(!HIST) return PRICE_PTS;
    const kc = HIST.t.map((t, i) => toPt(t, HIST.c[i]));
    if(PRICE_SRC === "coingecko" && PRICE_PTS.length){
      const first = PRICE_PTS[0].t - 12 * 36e5;
      return kc.filter(p => p.t < first).concat(PRICE_PTS);
    }
    const lastK = kc[kc.length - 1].t + 12 * 36e5;
    return kc.concat(PRICE_PTS.filter(p => p.t > lastK));
  }
  const OVERLAYS = [
    {key: "sma50", cls: "ov50", name: "50-day average"},
    {key: "sma200", cls: "ov200", name: "200-day average"},
    {key: "vwap90", cls: "ovvw", name: "90-day average traded price"}
  ];
  function drawPrice(){
    const box = $("bnChart");
    const src = HIST && (+RANGE > 92 || PRICE_SRC !== "coingecko") ? longPts() : PRICE_PTS;
    const now = src.length ? src[src.length - 1].t : Date.now();
    const from = now - (+RANGE) * 864e5;
    const pts = src.filter(p => p.t >= from);
    const badge = $("bnRangeChg");
    if(pts.length < 2){ box.innerHTML = ""; badge.textContent = ""; return; }
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    // the averages, clipped to the visible window
    const ovs = [];
    if(OV_ON && HIST){
      const S = IND.series(HIST, livePt());
      OVERLAYS.forEach(o => {
        const p = [];
        S.t.forEach((t, i) => { const v = S[o.key][i]; if(v != null && t >= t0 - 864e5 && t <= t1 + 36e5) p.push({t: Math.max(t0, Math.min(t1, t)), v}); });
        if(p.length > 1) ovs.push(Object.assign({pts: p, last: p[p.length - 1].v}, o));
      });
    }
    // Drawn at the box's real pixel size: the card stretches to the height of the
    // column beside it and the chart takes up whatever is left, without
    // distorting text or dots.
    const W = Math.max(280, Math.round(box.clientWidth || 800));
    const H = Math.max(200, Math.round(box.clientHeight || 236));
    const top = 14, bot = H - 6;
    // the scale includes the averages, so a line far above the price stays on the chart
    const all = pts.map(p => p.v).concat(...ovs.map(o => o.pts.map(p => p.v)));
    const lo0 = Math.min(...all), hi0 = Math.max(...all);
    const pad = (hi0 - lo0) * 0.08 || hi0 * 0.05;
    const lo = lo0 - pad, hi = hi0 + pad;
    const X = t => (t - t0) / ((t1 - t0) || 1) * W;
    const Y = v => bot - (v - lo) / ((hi - lo) || 1) * (bot - top);
    const path = a => a.map((p, i) => (i ? "L" : "M") + X(p.t).toFixed(1) + "," + Y(p.v).toFixed(1)).join(" ");
    const line = path(pts);
    // Days with no snapshot are not invented: the solid line breaks over any gap
    // longer than GAP_DAYS and a faint dashed segment bridges it.
    const GAP = 3 * 864e5;
    let solid = "", dashed = "";
    pts.forEach((p, i) => {
      const xy = X(p.t).toFixed(1) + "," + Y(p.v).toFixed(1);
      if(i && p.t - pts[i - 1].t > GAP){
        dashed += "M" + X(pts[i - 1].t).toFixed(1) + "," + Y(pts[i - 1].v).toFixed(1) + " L" + xy + " ";
        solid += " M" + xy;
      } else solid += (i ? " L" : "M") + xy;
    });
    const dec = hi < 0.1 ? 3 : 2;
    const grid = [0.25, 0.5, 0.75].map(f => {
      const y = top + (bot - top) * f, v = hi - (hi - lo) * f;
      return `<line class="grid" x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}"/>`
        + (f !== 0.5 ? `<text class="axis" x="${W}" y="${(y - 5).toFixed(1)}" text-anchor="end">$${v.toFixed(dec)}</text>` : "");
    }).join("");
    const last = pts[pts.length - 1];
    const first = pts[0];
    const ch = (last.v / first.v - 1) * 100;
    // name the real span: if the data does not reach back to the range start
    // (snapshot fallback), say "since <date>" rather than claim the full range
    const span = first.t - from > 3 * 864e5 ? "since " + first.d : RANGE === "365" ? "in a year" : "in " + RANGE + " days";
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="RIO price ${esc(span)}, from $${first.v.toFixed(4)} to $${last.v.toFixed(4)}${ovs.length ? ", with " + ovs.map(o => o.name).join(", ") : ""}">`
      // area under the line: green fading to nothing at the bottom (stop colours
      // come from CSS so the gradient follows the light and dark themes)
      + `<defs><linearGradient id="bnPriceFill" x1="0" y1="0" x2="0" y2="1"><stop class="g0" offset="0"/><stop class="g1" offset="1"/></linearGradient></defs>`
      + grid
      + `<path class="area" d="${line} L${X(t1).toFixed(1)},${bot} L0,${bot} Z" fill="url(#bnPriceFill)"/>`
      + ovs.map(o => `<path class="ov ${o.cls}" d="${path(o.pts)}"><title>${esc(o.name)}</title></path>`).join("")
      + `<path class="line" d="${solid}"/>`
      + (dashed ? `<path class="gap" d="${dashed}"><title>No daily snapshot for these days</title></path>` : "")
      + `<circle class="last" cx="${X(last.t).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="4.5"/></svg>`;
    badge.textContent = (ch >= 0 ? "▲ " : "▼ ") + pct1(ch).replace(/\.0%$/, "%") + " " + span;
    badge.className = "bn-badge" + (ch < 0 ? " is-down" : "");
    const leg = $("bnOvLeg");
    // say where the line switches source when KuCoin closes are part of it
    const joined = src !== PRICE_PTS && PRICE_SRC === "coingecko" && PRICE_PTS.length && PRICE_PTS[0].t > t0 + 864e5;
    leg.innerHTML = ovs.map(o => `<span class="${o.cls}"><i></i>${esc(o.name)} <b>$${o.last.toFixed(4)}</b></span>`).join("")
      + (joined ? `<span>KuCoin daily closes before ${esc(PRICE_PTS[0].d)}</span>` : "");
    leg.hidden = !ovs.length && !joined;
  }
  // Redraw when the chart box changes size (window resize, the mood card or the
  // news loading and changing the row height). Only on a real size change.
  if(window.ResizeObserver){
    let lastW = 0, lastH = 0, queued = false;
    new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
      if(Math.abs(w - lastW) < 2 && Math.abs(h - lastH) < 2) return;
      lastW = w; lastH = h;
      if(!queued){ queued = true; setTimeout(() => { queued = false; if(PRICE_PTS.length || HIST) drawPrice(); }, 60); }
    }).observe($("bnChart"));
  }
  document.querySelectorAll(".bn-tabs button").forEach(b => b.addEventListener("click", () => {
    RANGE = b.dataset.r;
    document.querySelectorAll(".bn-tabs button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    drawPrice();
  }));
  $("bnIndBtn").setAttribute("aria-pressed", String(OV_ON));
  $("bnIndBtn").addEventListener("click", () => {
    OV_ON = !OV_ON;
    $("bnIndBtn").setAttribute("aria-pressed", String(OV_ON));
    try { localStorage.setItem("rs-ind-ov", OV_ON ? "1" : "0"); } catch(e){}
    drawPrice();
  });

  loadPriceHistory();

  /* ---------- trading indicators card ----------
     Descriptive readings from indicators.js. Labels say where the price is,
     never "buy" or "sell": on RIO's own history the classic oversold signals
     were followed by further falls more often than rises (the methodology
     page re-runs that backtest daily). The on-chain tiles are filled from the
     network and large-transfer data further down this file (CTX). */
  const CTX = {};
  let VOL = null, BT_NOTE = null;
  getJ("./volume-history.json").then(v => { VOL = v; renderIndicators(); });
  const usd4 = v => "$" + v.toFixed(4);
  const sgnPct = x => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(100 * x).toFixed(0) + "%";
  const fmtD = d => { const x = new Date(d + "T00:00:00Z"); return x.getUTCDate() + " " + MON[x.getUTCMonth()] + (x.getUTCFullYear() !== new Date().getUTCFullYear() ? " " + x.getUTCFullYear() : ""); };
  const itile = (label, value, tag, tagCls, sub) =>
    `<div class="bn-tile"><div class="bn-ind-l">${label}</div><div class="v">${value}</div>`
    + (tag ? `<div class="bn-ind-tag${tagCls ? " " + tagCls : ""}">${tag}</div>` : "")
    + `<div class="bn-sub">${sub}</div></div>`;
  function renderIndicators(){
    if(!HIST) return;
    const r = IND.readings(HIST, livePt());
    const ext = t => /Oversold|Overbought|Below|Above/.test(t) ? "is-stretch" : "";
    // volume: all exchanges (CoinGecko, volume-history.json), latest 24h against the 30-day median
    let volTile = "";
    if(VOL && Array.isArray(VOL.daily) && VOL.latest_usd){
      const med = IND.median(VOL.daily.map(d => d.volume_usd).filter(x => x > 0));
      if(med){
        const x = VOL.latest_usd / med;
        volTile = itile("Volume vs its 30-day median", x.toFixed(1) + "x",
          x > 1.5 ? "Busier than usual" : x < 0.67 ? "Quieter than usual" : "About normal", "",
          "$" + Math.round(VOL.latest_usd / 1000) + "K traded in 24h, all exchanges");
      }
    }
    $("bnIndShort").innerHTML =
        itile("RSI, 14 days", r.rsi.toFixed(1), r.rsiTag, ext(r.rsiTag), "Under 30 is oversold, over 70 overbought")
      + itile("Lower Bollinger band", usd4(r.bbLo), r.bbTag, ext(r.bbTag), "Upper band " + usd4(r.bbHi) + ", 20 days, 2 deviations")
      + itile("vs the 20-day average", sgnPct(r.vs20), "", "", "Average " + usd4(r.sma20))
      + itile("Typical daily swing", "±" + (100 * r.atr).toFixed(0) + "%", "", "", "About " + usd4(r.atr * r.price) + " a day, 14-day average range")
      + volTile;
    $("bnIndLong").innerHTML =
        itile("vs the 50-day average", sgnPct(r.vs50), r.sma50Rising ? "Average rising" : "Average falling", r.sma50Rising ? "is-up" : "is-down", "Average " + usd4(r.sma50))
      + itile("vs the 200-day average", sgnPct(r.vs200), r.sma200Rising ? "Average rising" : "Average falling", r.sma200Rising ? "is-up" : "is-down", "Average " + usd4(r.sma200))
      + itile("vs the 90-day traded price", sgnPct(r.vsVwap90), "", "", "Traders paid " + usd4(r.vwap90) + " on average (KuCoin VWAP)")
      + itile("Above the 1-year low", sgnPct(r.vsYrLo), Math.round(100 * r.yrPos) + "% of the way up the range", "",
          "Low " + usd4(r.yrLo) + " on " + fmtD(r.yrLoDate) + ", high " + usd4(r.yrHi) + " on " + fmtD(r.yrHiDate))
      + itile("Trend", r.trend === "up" ? "Uptrend" : r.trend === "down" ? "Downtrend" : "Sideways", "", "",
          "Price against its 30-day average, and that average against a week ago");
    // on-chain context
    const chain = [];
    if(CTX.flow){
      const n = CTX.flow.net;
      chain.push(itile("Net exchange flow, 30 days", fmtM(M(Math.abs(n))) + (n >= 0 ? " out" : " in"),
        n >= 0 ? "More withdrawn than deposited" : "More deposited than withdrawn", "",
        "Transfers of 100k+ RIO: " + fmtM(M(CTX.flow.wd)) + " withdrawn, " + fmtM(M(CTX.flow.dep)) + " deposited"));
    }
    if(CTX.unb != null){
      const med = VOL && Array.isArray(VOL.daily) ? IND.median(VOL.daily.map(d => d.volume_usd).filter(x => x > 0)) : null;
      const days = med ? CTX.unb * r.price / med : null;
      const share = days == null ? "" : days >= 1 ? ", about " + days.toFixed(1) + " days of global trading volume"
        : ", " + (days < 0.01 ? "under 1%" : "about " + Math.round(100 * days) + "%") + " of one day's global trading volume";
      chain.push(itile("RIO unbonding now", CTX.unb >= 1e5 ? fmtM(M(CTX.unb)) : fmtInt(CTX.unb),
        "", "", (CTX.unb >= 1e5 ? "" : "RIO, ") + "released within 7 days" + share));
    }
    $("bnIndChain").innerHTML = chain.join("");
    $("bnIndChainG").hidden = !chain.length;
    $("bnIndAsOf").textContent = "Daily closes from KuCoin RIO-USDT to " + fmtD(r.asOf) + (r.provisional ? ", plus today's live price as a provisional close." : ".");
    // the honest caveat, computed from the same backtest the methodology page shows
    if(BT_NOTE == null){
      const bt = IND.backtest(HIST), base = bt[0], os = bt.find(x => x.key === "rsi30");
      BT_NOTE = os && os.med30 != null && base.med30 != null
        ? "In RIO's daily history since " + fmtD(IND.BT_FROM(HIST)) + ", an RSI under 30 was followed by a median " + sgnPct(os.med30)
          + " over the next 30 days, against " + sgnPct(base.med30) + " on an average day, so oversold has not reliably meant a bounce."
        : "";
    }
    $("bnIndNote").textContent = BT_NOTE;
    $("bnIndicators").hidden = false;
  }
  IND.load().then(H => {
    if(!H) return;
    HIST = H;
    document.querySelector('.bn-tabs button[data-r="365"]').hidden = false;
    drawPrice();
    renderIndicators();
  });

  /* ---------- bars ---------- */
  function bar(el, legendEl, parts, labelMin){
    const total = parts.reduce((a, p) => a + p.v, 0) || 1;
    el.innerHTML = parts.map(p => {
      const w = 100 * p.v / total;
      const lab = w >= (labelMin || 9) ? esc(p.short || p.name) + " " + Math.round(w) + "%" : "";
      return `<span style="width:${w.toFixed(2)}%;background:${p.color};color:${p.ink || "#0b1015"}" title="${esc(p.name)}: ${fmtM(M(p.v))} (${w.toFixed(1)}%)">${lab}</span>`;
    }).join("");
    if(legendEl) legendEl.innerHTML = parts.map(p =>
      `<span><i style="background:${p.color}"></i>${esc(p.name)} <b style="color:var(--ink);font-weight:600">${fmtM(M(p.v))}</b> · ${(100 * p.v / total).toFixed(1)}%</span>`).join("");
  }

  /* ---------- supply snapshot: chart, chain bar, integrity, strip ---------- */
  const supplyP = loadSupply().then(({arr, latest}) => {
    const snaps = arr.filter(r => typeof r.price_usd === "number" && r.price_usd > 0);
    SNAP_DAY = {};
    snaps.forEach(r => { SNAP_DAY[dayKey(Date.parse(r.ts))] = r.price_usd; });
    if(PRICE_SRC === "snapshots"){
      PRICE_PTS = snaps.map(r => toPt(Date.parse(r.ts), r.price_usd));
      drawPrice();
      renderIndicators();
    } else rebuildPrices();   // CoinGecko arrived first: apply the cross-check now

    $("bnCircTitle").textContent = fmtM(M(latest.tradable_total));
    const ch = latest.chains || {};
    const main = CHAINS.filter(c => ["bnb", "ethereum", "realio_native"].includes(c.key));
    const parts = main.map(c => ({name: c.name, short: c.key === "realio_native" ? "Native" : c.key === "bnb" ? "BNB" : "ETH",
      v: (ch[c.key] && ch[c.key].circulating) || 0, color: c.color, ink: c.key === "ethereum" ? "#ffffff" : "#0b1015"}));
    const rest = CHAINS.filter(c => !main.includes(c) && c.key !== "base")
      .reduce((a, c) => a + ((ch[c.key] && ch[c.key].circulating) || 0), 0);
    parts.sort((a, b) => b.v - a.v);
    if(rest > 0) parts.push({name: "Algorand, Stellar and Solana", short: "Other", v: rest, color: "#94a3b8"});
    bar($("bnChainBar"), $("bnChainLegend"), parts.filter(p => p.v > 0));

    // Supply integrity, same rule as the supply page's integrity line.
    const obs = computeObserved(arr), ed = latest.expected_daily_emission_rio;
    const halted = (latest.flags || []).some(f => String(f).indexOf("NATIVE_CHAIN_HALTED") === 0);
    const dot = $("bnIntDot"), txt = $("bnIntTxt"), sub = $("bnIntSub");
    if(halted){ dot.className = "idot warn"; txt.textContent = "Chain halted"; sub.textContent = "native supply frozen until blocks resume"; }
    else if(obs && ed && obs.perDay <= ed * 1.25){ dot.className = "idot ok"; txt.textContent = "On schedule"; }
    else if(obs && ed){ dot.className = "idot warn"; txt.textContent = "Above schedule"; }
    const infl = latest.mint && latest.mint.inflation_rate;
    const nat = ch.realio_native || {};
    const unminted = latest.native_cap && typeof (nat.total ?? nat.circulating) === "number" ? latest.native_cap - (nat.total ?? nat.circulating) : null;
    const ea = latest.expected_annual_emission_rio;
    if(!halted && infl) sub.textContent = (infl * 100).toFixed(1) + "%/yr set" + (ea && unminted > 0 ? ", ~" + (100 * ea / unminted).toFixed(1) + "% real" : "");

    // Strip: is the native chain live?
    const live = nat.chain_live !== false && !halted;
    $("bnLive").classList.toggle("is-down", !live);
    $("bnLiveTxt").textContent = live ? "Realio chain live" : "Realio chain halted";
    if(typeof ed === "number") $("bnEmit").textContent = "~" + fmtInt(ed) + " RIO / day";
    return {arr, latest};
  });

  /* ---------- network: staking ring, net flow, pool, minted, strip ---------- */
  Promise.all([getJ("./network-history.json"), supplyP]).then(([hist]) => {
    if(!Array.isArray(hist) || !hist.length) return;
    const rows = hist.filter(r => r.staking && typeof r.staking.bonded_weight === "number");
    const L = rows[rows.length - 1];
    if(!L) return;
    const st = L.staking;
    // native staked: same ratio as network.js "RIO bonding ratio · native"
    const rio = (st.pool_by_denom || []).find(x => x.label === "RIO");
    const rioPct = (rio && L.ario_supply) ? 100 * rio.amount / L.ario_supply : null;
    if(rioPct != null){
      $("bnStakedPct").textContent = rioPct.toFixed(1) + "%";
      $("bnRingFg").setAttribute("stroke-dashoffset", (213.6 * (1 - Math.min(rioPct, 100) / 100)).toFixed(1));
      $("bnRing").setAttribute("aria-label", rioPct.toFixed(1) + " percent of native RIO staked");
    }
    // net staking over 30 days: same window and day-by-day sum as network.js
    const cutoff = new Date(L.ts) - 30 * 864e5;
    const base30 = rows.filter(r => new Date(r.ts) <= cutoff + 12 * 36e5).pop() || rows[0];
    const win = rows.slice(rows.indexOf(base30));
    if(win.length > 1){
      const net = win.slice(1).reduce((a, r, i) => a + stakeFlow(win[i], r), 0);
      const el = $("bnNet30"); el.textContent = signM(net); el.className = "v " + (net > 0 ? "bn-up" : net < 0 ? "bn-down" : "");
    }
    const unb = st.unbonding != null ? st.unbonding : st.not_bonded;
    if(unb != null){ $("bnUnbond").textContent = fmtInt(unb) + " RIO unbonding"; CTX.unb = unb; renderIndicators(); }

    // staking pool by asset
    const COL = {RIO: ["#34d399", "#04130d"], DSTRX: ["#f472b6", "#1f0614"], RST: ["#8b9cf7", "#0b1015"]};
    const pool = (st.pool_by_denom || []).filter(p => p.amount > 0)
      .map(p => ({name: p.label, v: p.amount, color: (COL[p.label] || ["#94a3b8"])[0], ink: (COL[p.label] || [0, "#0b1015"])[1]}));
    if(pool.length){
      $("bnPoolTotal").textContent = fmtM(M(pool.reduce((a, p) => a + p.v, 0)));
      bar($("bnPoolBar"), $("bnPoolLegend"), pool);
      $("bnPoolSec").hidden = false;
    }
    // native minted against the cap
    if(L.native_cap && L.ario_supply){
      const share = 100 * L.ario_supply / L.native_cap;
      $("bnMinted").textContent = fmtM(M(L.ario_supply));
      $("bnMintedSub").textContent = "of the " + fmtM(M(L.native_cap)).replace(".0M", "M") + " native cap · " + share.toFixed(1) + "%";
      $("bnMintFill").style.width = share.toFixed(2) + "%";
      $("bnMintBar").setAttribute("aria-label", share.toFixed(1) + " percent of the native cap minted");
      if(L.daily_emission_adjusted) $("bnPerDay").textContent = fmtInt(L.daily_emission_adjusted);
      if(L.annual_emission_adjusted) $("bnPerYear").textContent = fmtM(M(L.annual_emission_adjusted));
      $("bnLeft").textContent = fmtM(M(L.native_cap - L.ario_supply));
      $("bnMintSec").hidden = false;
    }
    // strip
    if(L.height) $("bnHeight").textContent = fmtInt(L.height);
    if(L.block_time_s) $("bnBlockTime").textContent = L.block_time_s.toFixed(2) + "s";
    const v = L.validators || {};
    if(v.active) $("bnVals").textContent = v.active + " validators" + (typeof v.jailed_in_set === "number" ? ", " + v.jailed_in_set + " jailed" : "");
  });

  /* ---------- holders: total and 12-month trend ---------- */
  Promise.all([getJ("./holders-evm.json"), getJ("./holders-chains.json"), supplyP]).then(([evm, other, s]) => {
    const ec = (evm && evm.chains) || {}, oc = (other && other.chains) || {};
    let total = 0;
    Object.values(ec).forEach(c => { if(typeof c.total === "number") total += c.total; });
    Object.values(oc).forEach(c => { if(typeof c.total === "number") total += c.total; });
    const nh = s && s.latest && s.latest.native_holders;
    if(nh && typeof nh.total === "number") total += nh.total;
    if(total) $("bnHolders").textContent = "~" + Math.round(total / 1000) + "K";
    // trend from the BNB + Ethereum monthly history (the chains that carry one)
    const months = {};
    Object.values(ec).forEach(c => (c.history || []).forEach(h => {
      const m = months[h.month] || (months[h.month] = {gte_1k: 0, gte_100k: 0, n: 0});
      m.gte_1k += h.gte_1k || 0; m.gte_100k += h.gte_100k || 0; m.n++;
    }));
    const keys = Object.keys(months).filter(k => months[k].n === Object.keys(ec).length).sort();
    if(keys.length >= 2){
      const now = keys[keys.length - 1], [y, mo] = now.split("-").map(Number);
      const ago = (y - 1) + "-" + String(mo).padStart(2, "0");
      const base = months[ago] ? ago : keys[0];
      const a = months[base], b = months[now];
      const d = (x, y0) => y0 ? 100 * (x / y0 - 1) : null;
      const w = d(b.gte_100k, a.gte_100k), k = d(b.gte_1k, a.gte_1k);
      const span = base === ago ? "12 mo" : "since " + base;
      const row = (p, label) => p == null ? "" :
        `<span class="${p >= 0 ? "bn-up" : "bn-down"}">${p >= 0 ? "▲" : "▼"} ${Math.round(Math.abs(p))}%</span> ${label}`;
      $("bnHoldTrend").innerHTML = [row(w, "100k+ wallets"), row(k, "1k+ wallets · " + span)].filter(Boolean).join("<br>");
      $("bnHoldTrend").title = "BNB Chain and Ethereum wallets, " + base + " to " + now;
    }
  });

  /* ---------- who holds the tradable RIO (same venue data as computeFloat) ---------- */
  Promise.all([getJ("./holders.json"), getJ("./holders-evm.json"), supplyP]).then(([h, evm, s]) => {
    const v = evm && evm.venues;
    if(h && v){
      h = Object.assign({}, h);
      if(Array.isArray(v.bsc_exchanges)) h.bsc_exchanges = v.bsc_exchanges;
      if(Array.isArray(v.eth_holders)) h.eth_holders = v.eth_holders;
    }
    if(!h || !s) return;
    const f = computeFloat(s.latest, h);
    const groups = {};
    const add = (name, rio) => { groups[name] = (groups[name] || 0) + rio; };
    (h.bsc_exchanges || []).filter(x => !x.note).forEach(x => add(/DEX/i.test(x.entity) ? "DEX pools" : x.entity, x.rio));
    (h.eth_holders || []).filter(x => !x.note && !/bridge/i.test(x.type || "")).forEach(x => add(/DEX/i.test(x.type || "") ? "DEX pools" : x.holder, x.rio));
    const COL = ["#8b9cf7", "#34d399", "#f59e0b", "#f472b6", "#94a3b8"];
    const parts = Object.entries(groups).sort((a, b) => b[1] - a[1]).map(([name, v], i) => ({name, v, color: COL[i] || "#94a3b8"}));
    if(!parts.length) return;
    $("bnVenueTotal").textContent = fmtM(M(f.withMarket));
    bar($("bnVenueBar"), $("bnVenueLegend"), parts, 12);
    if(f.dead > 0){
      const n = document.createElement("span");
      n.textContent = "Plus " + fmtM(M(f.dead)) + " in exchange wallets with no live market.";
      $("bnVenueLegend").append(n);
    }
    $("bnVenueSec").hidden = false;
  });

  /* ---------- large transfers ---------- */
  const CH = {
    native: {name: "Native", tx: "https://explorer.realio.network/transactions/", addr: "https://explorer.realio.network/accounts/"},
    bnb: {name: "BNB", tx: "https://bscscan.com/tx/", addr: "https://bscscan.com/address/"},
    eth: {name: "Ethereum", tx: "https://etherscan.io/tx/", addr: "https://etherscan.io/address/"},
    base: {name: "Base", tx: "https://basescan.org/tx/", addr: "https://basescan.org/address/"},
    solana: {name: "Solana", tx: "https://solscan.io/tx/", addr: "https://solscan.io/account/"},
    algorand: {name: "Algorand", tx: "https://allo.info/tx/", addr: "https://allo.info/account/"},
    stellar: {name: "Stellar", tx: "https://stellar.expert/explorer/public/tx/", addr: "https://stellar.expert/explorer/public/account/"}
  };
  const KIND = {withdrawal: ["Withdrawal", "k-withdrawal"], deposit: ["Deposit", "k-deposit"], exchange: ["Exchange internal", ""],
    bridge_out: ["Bridge out", "k-bridge"], bridge_in: ["Bridge in", "k-bridge"], ibc_out: ["IBC out", "k-bridge"], ibc_in: ["IBC in", "k-bridge"],
    dex: ["DEX", ""], mint: ["Issuer mint", ""], burn: ["Issuer burn", ""], wallet: ["Wallet", ""]};
  function party(r, side){
    const a = r[side], label = r[side + "_label"], c = CH[r.chain];
    const ok = a && c && !/^(MINT|BURN|ISSUER)$/.test(a) && !(r.chain === "stellar" && !/^G/.test(a)) && !/^account#/.test(a);
    const inner = label ? esc(label) : `<span class="addr">${esc(short(a))}</span>`;
    return ok ? `<a href="${esc(c.addr + a)}" target="_blank" rel="noopener" title="${esc(a)}" style="color:inherit">${inner}</a>` : inner;
  }
  // Daily 30-day list (GitHub job) plus anything the live Worker found since
  // (realiostats.com/api/live-transfers, checked every minute on all seven chains).
  Promise.all([getJ("./large-transfers.json"), getJ("/api/live-transfers")]).then(([d, live]) => {
    const daily = d && Array.isArray(d.transfers) ? d.transfers : [];
    const seen = new Set(daily.map(t => t.id));
    daily.forEach(t => seen.add(t.chain + "|" + String(t.tx).toLowerCase() + "|" + Math.round(t.amount)));
    const fresh = live && Array.isArray(live.transfers) ? live.transfers.filter(t => t && t.ts && !seen.has(t.id)
      && !seen.has(t.chain + "|" + String(t.tx).toLowerCase() + "|" + Math.round(t.amount))).map(t => ({...t, live: true})) : [];
    const T = daily.concat(fresh).sort((a, b) => b.ts - a.ts);
    if(!T.length) return;
    const chk = live && Date.parse(live.checked);
    if(chk && Date.now() - chk < 10 * 6e4){
      const c = new Date(chk);
      $("bnLtLiveTxt").textContent = "Live · checked " + String(c.getUTCHours()).padStart(2, "0") + ":" + String(c.getUTCMinutes()).padStart(2, "0") + " UTC";
      $("bnLtLive").title = "Checked every minute on all seven chains. Bridge legs are paired in the daily update.";
      $("bnLtLive").hidden = false;
    }
    const asOf = fresh.length || chk ? Date.now() : (Date.parse(d && d.as_of) || Date.now());
    const wk = T.filter(t => t.ts * 1000 >= asOf - 7 * 864e5);
    const sum = a => a.reduce((s, t) => s + t.amount, 0);
    const dep = sum(T.filter(t => t.kind === "deposit")), wd = sum(T.filter(t => t.kind === "withdrawal"));
    const net = wd - dep;
    CTX.flow = {net, wd, dep}; renderIndicators();
    const big = T.filter(t => !["exchange", "deposit", "withdrawal"].includes(t.kind)).sort((a, b) => b.amount - a.amount)[0];
    const tile = (v, s, hi) => `<div class="bn-tile"${hi ? ' style="background:var(--mint-soft);border-color:rgba(52,211,153,.4)"' : ""}><div class="v${hi ? " bn-up" : ""}">${v}</div><div class="bn-sub">${s}</div></div>`;
    $("bnLtTiles").innerHTML =
        tile(String(wk.length), "moves in the last 7 days · " + fmtM(M(sum(wk))) + " RIO")
      + tile(fmtM(M(Math.abs(net))) + (net >= 0 ? " out" : " in"), "net " + (net >= 0 ? "off" : "onto") + " exchanges, 30 days", net > 0)
      + tile(fmtM(M(wd)) + " / " + fmtM(M(dep)), "withdrawn vs deposited, 30 days")
      + (big ? tile(fmtM(M(big.amount)), "largest outside exchanges · " + (big.kind === "wallet" ? "wallet to wallet" : big.kind === "dex" ? "DEX swap" : (KIND[big.kind] || KIND.wallet)[0].toLowerCase()) + " on " + (CH[big.chain] || {name: big.chain}).name) : "");
    $("bnLtAll").textContent = "All " + T.length + " transfers →";
    $("bnLtBody").innerHTML = T.slice(0, 6).map(r => {
      const dt = new Date(r.ts * 1000), c = CH[r.chain] || {name: r.chain};
      const time = dt.getUTCDate() + " " + MON[dt.getUTCMonth()] + " " + String(dt.getUTCHours()).padStart(2, "0") + ":" + String(dt.getUTCMinutes()).padStart(2, "0");
      const k = KIND[r.kind] || KIND.wallet;
      const amt = Math.round(r.amount).toLocaleString("en-US");
      const amtCell = c.tx && r.tx ? `<a href="${esc(c.tx + r.tx)}" target="_blank" rel="noopener" style="color:inherit">${amt}</a>` : amt;
      return `<tr><td>${time}${r.live ? '<span class="bn-new" title="Found by the live check, added to the full list at the next daily update">new</span>' : ""}</td><td>${esc(c.name)}</td><td class="num">${amtCell}</td><td>${party(r, "from")}</td><td>${party(r, "to")}</td><td><span class="bn-kind ${k[1]}">${k[0]}</span></td></tr>`;
    }).join("");
    $("bnTransfers").hidden = false;
  });
})();
