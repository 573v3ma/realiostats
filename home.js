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

  // Curated pins for the price chart: events the site itself documents.
  const PINS = [
    {date: "2026-08-25", label: "25 Aug · the theft on Algorand, Stellar and native", href: "incident.html", color: "#f59e0b"},
    {date: "2026-09-11", label: "11 Sep · MEXC's Algorand RIO reissued on Ethereum", href: "supply.html#excluded", color: "#8b9cf7"}
  ];

  /* ---------- price chart (snapshot price, one point per daily reading) ---------- */
  let PRICE_PTS = [], RANGE = "90";
  function drawPrice(){
    const box = $("bnChart");
    const now = PRICE_PTS.length ? PRICE_PTS[PRICE_PTS.length - 1].t : Date.now();
    const pts = RANGE === "all" ? PRICE_PTS : PRICE_PTS.filter(p => p.t >= now - (+RANGE) * 864e5);
    const badge = $("bnRangeChg");
    if(pts.length < 2){ box.innerHTML = ""; badge.textContent = ""; return; }
    const W = 800, H = 236, top = 14, bot = 214;
    const lo0 = Math.min(...pts.map(p => p.v)), hi0 = Math.max(...pts.map(p => p.v));
    const pad = (hi0 - lo0) * 0.08 || hi0 * 0.05;
    const lo = lo0 - pad, hi = hi0 + pad;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const X = t => (t - t0) / ((t1 - t0) || 1) * W;
    const Y = v => bot - (v - lo) / ((hi - lo) || 1) * (bot - top);
    const line = pts.map((p, i) => (i ? "L" : "M") + X(p.t).toFixed(1) + "," + Y(p.v).toFixed(1)).join(" ");
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
    const grid = [0.25, 0.5, 0.75].map(f => {
      const y = top + (bot - top) * f, v = hi - (hi - lo) * f;
      return `<line class="grid" x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}"/>`
        + (f !== 0.5 ? `<text class="axis" x="${W}" y="${(y - 5).toFixed(1)}" text-anchor="end">$${v.toFixed(3)}</text>` : "");
    }).join("");
    const pins = PINS.map((p, i) => {
      const t = Date.parse(p.date + "T12:00:00Z");
      if(t < t0 || t > t1) return "";
      const near = pts.reduce((a, b) => Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a);
      const x = X(t).toFixed(1), y = Y(near.v).toFixed(1);
      return `<g class="pin"><line x1="${x}" y1="${y}" x2="${x}" y2="${bot + 6}" stroke="${p.color}"/>`
        + `<circle cx="${x}" cy="${y}" r="5" fill="var(--alt)" stroke="${p.color}" stroke-width="2"/>`
        + `<circle cx="${x}" cy="${bot + 12}" r="9" fill="${p.color}"/><text x="${x}" y="${bot + 16}" text-anchor="middle">${i + 1}</text></g>`;
    }).join("");
    const last = pts[pts.length - 1];
    const first = pts[0];
    const ch = (last.v / first.v - 1) * 100;
    const span = RANGE === "all" ? "since " + first.d : "in " + RANGE + " days";
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="RIO price ${esc(span)}, from $${first.v.toFixed(4)} to $${last.v.toFixed(4)}">`
      + grid
      + `<path class="area" d="${line} L${X(t1).toFixed(1)},${bot} L0,${bot} Z"/>`
      + `<path class="line" d="${solid}"/>`
      + (dashed ? `<path class="gap" d="${dashed}"><title>No daily snapshot for these days</title></path>` : "") + pins
      + `<circle class="last" cx="${X(last.t).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="4.5"/></svg>`;
    badge.textContent = (ch >= 0 ? "▲ " : "▼ ") + pct1(ch).replace(/\.0%$/, "%") + " " + span;
    badge.className = "bn-badge" + (ch < 0 ? " is-down" : "");
    // pin legend (keeps the price source span at the end)
    const leg = $("bnPins"), src = $("priceSrc");
    leg.textContent = "";
    PINS.forEach((p, i) => {
      const t = Date.parse(p.date + "T12:00:00Z");
      if(t < t0 || t > t1) return;
      const a = document.createElement("a"); a.href = p.href; a.style.color = "inherit";
      const b = document.createElement("b"); b.textContent = String(i + 1); b.style.color = p.color;
      a.append(b, p.label); leg.append(a);
    });
    leg.append(src);
  }
  document.querySelectorAll(".bn-tabs button").forEach(b => b.addEventListener("click", () => {
    RANGE = b.dataset.r;
    document.querySelectorAll(".bn-tabs button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    drawPrice();
  }));

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
    PRICE_PTS = arr.filter(r => typeof r.price_usd === "number" && r.price_usd > 0).map(r => {
      const t = Date.parse(r.ts), d = new Date(t);
      return {t, v: r.price_usd, d: d.getUTCDate() + " " + MON[d.getUTCMonth()]};
    });
    drawPrice();

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
    if(unb != null) $("bnUnbond").textContent = fmtInt(unb) + " RIO unbonding";

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
  getJ("./large-transfers.json").then(d => {
    const T = d && Array.isArray(d.transfers) ? d.transfers.slice().sort((a, b) => b.ts - a.ts) : [];
    if(!T.length) return;
    const asOf = Date.parse(d.as_of) || Date.now();
    const wk = T.filter(t => t.ts * 1000 >= asOf - 7 * 864e5);
    const sum = a => a.reduce((s, t) => s + t.amount, 0);
    const dep = sum(T.filter(t => t.kind === "deposit")), wd = sum(T.filter(t => t.kind === "withdrawal"));
    const net = wd - dep;
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
      return `<tr><td>${time}</td><td>${esc(c.name)}</td><td class="num">${amtCell}</td><td>${party(r, "from")}</td><td>${party(r, "to")}</td><td><span class="bn-kind ${k[1]}">${k[0]}</span></td></tr>`;
    }).join("");
    $("bnTransfers").hidden = false;
  });
})();
