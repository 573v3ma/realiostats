/* realiostats — network page. The staking-yield ladder, what secures the chain,
   and validator-set health. Requires core.js.

   Everything here comes from network-history.json (one row per day, written by
   fetch_network.py) and network-validators.json (current set, overwritten daily).
   No live calls: the numbers move slowly and the daily row is the audit trail. */

/* Frozen snapshot so the page still renders if the fetch is blocked (file://,
   offline). Same role as FALLBACK in core.js. */
const NET_FALLBACK = {
  "ts":"2026-08-21T06:00:00Z","height":19509300,"native_cap":175000000,
  "ario_supply":88217998,"unminted":86782002,
  "mint":{"inflation_rate":0.08,"blocks_per_year":6311520,"assumed_block_time_s":4.9966},
  "block_time_s":5.6483,"block_adjust_factor":0.8846,
  "annual_emission_nominal":6942560,"annual_emission_adjusted":6141481,
  "daily_emission_adjusted":16826,"community_tax":0.02,
  "staking":{"bonded_weight":131623513,"not_bonded":4261194,"max_validators":100,
    "min_commission_rate":0.05,"unbonding_time":"604800s","multistaking_pool_total":136368024,
    "rio_pct_of_pool":51.41,
    "pool_by_denom":[{"label":"RIO","amount":70100644,"pct_of_pool":51.41},
                     {"label":"DSTRX","amount":36665250,"pct_of_pool":26.89},
                     {"label":"RST","amount":29602130,"pct_of_pool":21.71}]},
  "validators":{"active":55,"jailed_in_set":0,"nakamoto_coefficient":7,
    "top5_pct":27.3,"top10_pct":50.02,
    "commission_min":0.05,"commission_median":0.1,"commission_max":0.1},
  "yield_ladder":{"mint_parameter":0.08,"official_apr":0.052746,"block_adjusted":0.046659,
    "after_community_tax":0.045726,"after_min_commission":0.043439,
    "after_med_commission":0.043439,"after_max_commission":0.041153}
};

const pct2 = n => (n == null ? "—" : (n * 100).toFixed(2) + "%");
const pct0 = n => (n == null ? "—" : Math.round(n * 100) + "%");

/* The ladder is the whole point of this page: one number without its basis is
   what caused the confusion in the first place, so every rung states what it
   measures and what was deducted to get there. */
function renderLadder(s) {
  const y = s.yield_ladder || {}, tax = s.community_tax;
  const bt = s.block_time_s, abt = (s.mint || {}).assumed_block_time_s;
  const drift = (bt && abt) ? (100 * (bt - abt) / abt) : null;
  const cMin = (s.validators || {}).commission_min, cMax = (s.validators || {}).commission_max;

  const rungs = [
    { v: pct2(y.mint_parameter), sub: "mint parameter", cls: "",
      k: 'The 8% you read in the docs <span class="rtag grey">not a yield</span>',
      x: "Charged on <b>unminted</b> native supply, the gap between today's supply and the 175M cap, "
       + "not on supply and not on your stake. It sets how much new RIO is created, not what you earn. "
       + "The base shrinks as the cap fills, so the RIO amount falls a little every year." },

    { v: pct2(y.official_apr), sub: "official APR", cls: "is-official",
      k: 'What app.realio.network shows <span class="rtag grey">gross</span>',
      x: "Nominal annual emission divided by total bonded weight. A fair measure of gross issuance "
       + "yield, and it is what the official staking page displays. It is calculated before the "
       + "community tax and on the nominal block schedule, so it sits above what a delegator receives." },

    { v: pct2(y.block_adjusted), sub: "block-adjusted", cls: "",
      k: "After the chain's real block speed",
      x: "The mint module pays a fixed provision <b>per block</b>. Realio produces blocks at about "
       + (bt ? "<b>" + bt.toFixed(2) + "s</b>" : "its real rate")
       + " against the " + (abt ? "<b>" + abt.toFixed(2) + "s</b>" : "rate")
       + " its <code>blocks_per_year</code> parameter assumes"
       + (drift ? ", roughly <b>" + drift.toFixed(0) + "% slower</b>" : "")
       + ", so real annual issuance lands below nominal. This is the same correction the "
       + '<a href="index.html#emissions">emissions panel</a> applies to supply.' },

    { v: pct2(y.after_community_tax), sub: "after tax", cls: "",
      k: "After the " + pct0(tax) + " community tax",
      x: "Taken off the top before rewards are distributed. This is what actually reaches the "
       + "delegator pool, and it is the figure we verified against the chain by sampling a "
       + "validator's accruing rewards directly." },

    { v: pct2(y.after_min_commission), sub: "in your wallet", cls: "is-final",
      k: 'After ' + pct0(cMin) + ' validator commission <span class="rtag">what you receive</span>',
      x: "Your validator's cut comes off your share. " + pct0(cMin) + " is the network minimum and what the "
       + "large majority of validators charge"
       + '<span id="commShare"></span>'
       + ", so it is the figure to use. The few validators above the minimum charge up to " + pct0(cMax)
       + (y.after_max_commission ? ", which would bring this to " + pct2(y.after_max_commission) : "") + "." }
  ];

  document.getElementById("ladder").innerHTML = rungs.map(r =>
    `<div class="rung ${r.cls}">
       <div><div class="rv">${r.v}</div><span class="rvsub">${r.sub}</span></div>
       <div><div class="rk">${r.k}</div><div class="rx">${r.x}</div></div>
     </div>`).join("");

  const gap = (y.official_apr && y.after_min_commission)
    ? (100 * (1 - y.after_min_commission / y.official_apr)).toFixed(0) : null;
  document.getElementById("ladderRead").innerHTML =
    "None of these numbers is wrong, and none of them contradicts the others. They measure "
    + "different points on the same chain of deductions, which is why quoting any single one "
    + "without its basis causes arguments. Between the headline APR and what lands in a wallet "
    + (gap ? "there is about " + (/^(8|11|18)/.test(gap) ? "an" : "a") + " <b>" + gap + "% difference</b>" : "there is a material difference")
    + ", and every step of it is on-chain and checkable."
    + " RIO staking rewards are always paid in RIO.";

  document.getElementById("yieldCap").innerHTML =
    "Read live each day from Realio's public LCD: mint parameters from <code>/realionetwork/mint/v1/params</code>, "
    + "the bonded base from <code>/cosmos/staking/v1beta1/pool</code>, the community tax from "
    + "<code>/cosmos/distribution/v1beta1/params</code>, and block time measured across "
    + (s.block_time_span ? "<b>" + fmtInt(s.block_time_span) + "</b> blocks" : "a block window")
    + ". Emission is <code>(175M − native supply) × " + pct0((s.mint || {}).inflation_rate)
    + "</code>, block-rate adjusted. The method behind rung 4 was checked against the chain directly on "
    + "21 August 2026, by reading a validator's outstanding rewards over a 39-second window and annualising: "
    + "4.59% measured against 4.58% derived at that moment, a 0.14% difference. The live figure above moves "
    + "with block time and the bonded base. The final rung uses the network minimum commission, which is what most validators charge; check your own validator's rate. "
    + "This is a yield figure, not part of the supply count.";
}

/* Why the yield is where it is: newly minted RIO is shared across a bonded base
   that is only about half RIO. Without this, the ladder looks arbitrary. */
function renderBase(s) {
  const st = s.staking || {}, rows = st.pool_by_denom || [];
  const max = Math.max(...rows.map(r => r.amount), 1);
  document.getElementById("baseBody").innerHTML = rows.map(r =>
    `<tr><td><span class="vbar" style="width:${Math.round(46 * r.amount / max)}px"></span>${r.label}</td>
         <td>${fmtM(M(r.amount))} <span class="base-usd" data-label="${r.label}" style="color:#69747f"></span></td><td>${r.pct_of_pool}%</td></tr>`).join("")
    + `<tr class="lq-total"><td>Multistaking pool</td><td>${fmtM(M(st.multistaking_pool_total))} <span class="base-usd" data-label="TOTAL" style="color:#69747f"></span></td><td>100%</td></tr>`;

  // Dollar value in brackets beside each amount. RST has no public market, so
  // it reads "unpriced" and the pool total is a floor ("≥").
  getPrices().then(({ prices, live }) => {
    let total = 0, priced = 0;
    rows.forEach(r => { const p = prices[r.label]; if (typeof p === "number") { total += r.amount * p; priced++; } });
    document.querySelectorAll("#baseBody .base-usd").forEach(el => {
      const l = el.dataset.label;
      if (l === "TOTAL") { el.textContent = priced ? "(≥ " + usdShort(total) + ")" : ""; return; }
      const r = rows.find(x => x.label === l), p = prices[l];
      el.textContent = typeof p === "number" ? "(" + usdShort(r.amount * p) + ")" : "(unpriced)";
    });
    const cap = document.getElementById("baseUsdNote");
    if (cap) cap.innerHTML = "Dollar values in brackets use " + (live ? "current CoinGecko prices" : "the last snapshot RIO price")
      + ". DSTRX trades very thinly, so its figure is a last reported price rather than a deep market. "
      + "RST has no public market price and is left unpriced rather than guessed, so the pool total is a floor.";
  });

  document.getElementById("baseNote").innerHTML =
    "Realio uses multistaking: validators are secured by RIO, RST and DSTRX together, each bonded at "
    + "weight 1.0. Newly minted RIO is shared across the <b>whole</b> base, not just the RIO part, so with "
    + "RIO at <b>" + st.rio_pct_of_pool + "%</b> of the pool the yield on a RIO delegation is materially "
    + "lower than the emission rate alone would suggest. Figures are the multistaking module account's "
    + "balances, which cover bonded plus unbonding tokens, so they sum a little above the "
    + fmtM(M(st.bonded_weight)) + " of bonded voting weight. "
    + "The per-denom split is not published by the multistaking module itself, whose REST routes return 501; "
    + "it is read from the module account's bank balances instead. Bond weight 1.0 is therefore inferred "
    + "rather than read, and the pipeline re-checks that inference every day by confirming these balances "
    + "still reconcile with bonded plus unbonding stake.";
}

function renderValidators(s, vd) {
  const v = s.validators || {}, st = s.staking || {};
  const chip = (n, val, x) => `<div class="chip"><div class="cn">${n}</div><div class="cv">${val}</div><div class="cx">${x}</div></div>`;
  document.getElementById("valChips").innerHTML =
      chip("Active validators", v.active, "of " + st.max_validators + " slots, none jailed")
    + chip("Nakamoto coefficient", v.nakamoto_coefficient, "validators needed to halt the chain")
    + chip("Top 10 share", (v.top10_pct != null ? v.top10_pct.toFixed(1) + "%" : "—"), "of bonded voting weight")
    + chip("Commission", pct0(v.commission_min) + "–" + pct0(v.commission_max), "network minimum is " + pct0(st.min_commission_rate))
    + chip("Unbonding", (st.unbonding_time ? Math.round(parseInt(st.unbonding_time) / 86400) + " days" : "—"), "before stake is liquid again");

  const body = document.getElementById("valBody");
  if (!vd || !Array.isArray(vd.validators)) { body.innerHTML = ""; return; }
  const total = vd.bonded_weight || vd.validators.reduce((a, x) => a + x.weight, 0);

  // Back the ladder's "most validators charge the minimum" with the live count.
  const cs = document.getElementById("commShare");
  if (cs && v.commission_min != null) {
    const atMin = vd.validators.filter(x => Math.abs(x.commission - v.commission_min) < 1e-9);
    const wMin = atMin.reduce((a, x) => a + x.weight, 0);
    cs.innerHTML = " (<b>" + atMin.length + " of " + vd.validators.length + "</b> active validators, holding <b>"
      + (100 * wMin / total).toFixed(1) + "%</b> of stake)";
  }
  // The set spans four orders of magnitude, from 7.6M down to a few thousand.
  // fmtM would render the tail as a wall of "0.00M", so small stakes show whole.
  const w = n => n >= 1e5 ? fmtM(M(n)) : fmtInt(n);
  body.innerHTML = vd.validators.map((x, i) =>
    `<tr><td>${i + 1}</td><td>${x.moniker || "—"}</td><td>${w(x.weight)}</td>
         <td>${(100 * x.weight / total).toFixed(2)}%</td><td>${pct0(x.commission)}</td></tr>`).join("");

  document.getElementById("valCap").innerHTML =
    "Active set as of " + (vd.as_of ? vd.as_of.slice(0, 10) : "the latest reading")
    + (vd.height ? " at height " + fmtInt(vd.height) : "")
    + ", from <code>/cosmos/staking/v1beta1/validators</code>. Weight is bonded stake across all three "
    + "staking denoms, so it is voting power rather than RIO held. The Nakamoto coefficient is the smallest "
    + "number of validators that together exceed one third of voting power, the point at which they could halt "
    + "the chain: higher is more decentralised. It is a concentration measure, not an accusation, and it moves "
    + "as delegations shift.";
}

/* Staking flow — how the bonded base has moved day to day, not just where it
   sits today. Same source file as the ladder (network-history.json), just the
   full run instead of only the last row. bonded_weight/not_bonded are voting
   weight across all three staking denoms (see #base), not a RIO count, so the
   flow here is a decentralisation/confidence signal rather than a RIO amount. */
let FLOW_CHART = null;

const flowCls = d => d > 0 ? "up" : d < 0 ? "down" : "flat";
const flowStr = d => (d > 0 ? "+" : "") + fmtM(M(d));

function renderStakingFlow(hist) {
  const wrap = document.getElementById("staking");
  if (!wrap || !Array.isArray(hist) || hist.length === 0) return;

  const rows = hist.filter(r => r.staking && typeof r.staking.bonded_weight === "number");
  const latest = rows[rows.length - 1];
  const first = rows[0];
  const st = latest.staking;
  const rio = (st.pool_by_denom || []).find(x => x.label === "RIO");
  const rioPct = (rio && latest.ario_supply) ? 100 * rio.amount / latest.ario_supply : null;

  const netTotal = rows.length > 1 ? latest.staking.bonded_weight - first.staking.bonded_weight : 0;
  const days = rows.length > 1
    ? Math.max(1, Math.round((new Date(latest.ts) - new Date(first.ts)) / 86400000)) : 0;

  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const netDay = prev ? latest.staking.bonded_weight - prev.staking.bonded_weight : null;
  const gapH = prev ? Math.round((new Date(latest.ts) - new Date(prev.ts)) / 3600000) : null;
  const dayLabel = gapH == null ? "24h" : Math.abs(gapH - 24) <= 3 ? "24h" : gapH + "h";

  document.getElementById("flowChips").innerHTML =
      `<div class="chip"><div class="cn">Bonded voting weight</div><div class="cv">${fmtM(M(st.bonded_weight))} <span id="bondedUsd" style="font-size:.55em;font-weight:500;color:#69747f"></span></div>
        <div class="cx">across RIO, RST and DSTRX combined</div></div>`
    + `<div class="chip"><div class="cn">Net flow · ${dayLabel}</div>
        <div class="cv chg ${netDay == null ? "flat" : flowCls(netDay)}">${netDay == null ? "—" : flowStr(netDay)}</div>
        <div class="cx">${netDay == null
            ? "need a second reading"
            : (netDay >= 0 ? "staked more than unstaked" : "unstaked more than staked") + " vs the previous snapshot"}</div></div>`
    + `<div class="chip"><div class="cn">Net flow${days ? " · since tracking, " + days + "d" : ""}</div>
        <div class="cv chg ${flowCls(netTotal)}">${rows.length > 1 ? flowStr(netTotal) : "—"}</div>
        <div class="cx">${rows.length > 1
            ? (netTotal >= 0 ? "more staked than unstaked" : "more unstaked than staked") + " since tracking began"
            : "tracking just started, check back tomorrow"}</div></div>`
    + `<div class="chip"><div class="cn">RIO bonding ratio</div><div class="cv">${rioPct != null ? rioPct.toFixed(1) + "%" : "—"}</div>
        <div class="cx">of circulating native RIO supply</div></div>`
    + `<div class="chip"><div class="cn">Unbonding queue</div><div class="cv">${fmtM(M(st.not_bonded))}</div>
        <div class="cx">mid-unbond, liquid again within ${st.unbonding_time ? Math.round(parseInt(st.unbonding_time) / 86400) : 7} days</div></div>`;

  renderBondedUsd(st);

  const labels = rows.map(r => new Date(r.ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
  const bonded = rows.map(r => +M(r.staking.bonded_weight).toFixed(3));
  const dayFlow = rows.map((r, i) => i === 0 ? null : +(r.staking.bonded_weight - rows[i - 1].staking.bonded_weight).toFixed(0));

  if (FLOW_CHART) FLOW_CHART.destroy();
  FLOW_CHART = new Chart(document.getElementById("flowChart"), {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "Net daily flow", data: dayFlow, yAxisID: "y1",
          backgroundColor: dayFlow.map(d => d == null ? "transparent" : d >= 0 ? "#34d399" : "#fb7185"),
          borderRadius: 3, order: 2 },
        { type: "line", label: "Bonded weight", data: bonded, yAxisID: "y",
          borderColor: "#0b1015", backgroundColor: "#0b1015", borderWidth: 2, tension: .25,
          pointRadius: rows.length < 40 ? 3 : 0, pointBackgroundColor: "#0b1015", fill: false, order: 1 }
      ]
    },
    plugins: [watermarkPlugin],
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      interaction: { mode: "index", intersect: false },
      scales: {
        y: { position: "left", grid: { color: "#eef1f4" },
             ticks: { callback: v => v + "M", color: "#69747f", font: { family: "Inter" } },
             title: { display: true, text: "Bonded weight (M)", color: "#69747f", font: { family: "Inter", size: 11 } } },
        y1: { position: "right", grid: { display: false },
              ticks: { callback: v => (v >= 0 ? "+" : "") + fmtInt(v), color: "#69747f", font: { family: "Inter" } },
              title: { display: true, text: "Net daily flow", color: "#69747f", font: { family: "Inter", size: 11 } } },
        x: { grid: { display: false }, ticks: { color: "#69747f", font: { family: "Inter", size: 11 }, maxRotation: 0, autoSkipPadding: 14 } }
      },
      plugins: {
        legend: { labels: { color: "#0b1015", font: { family: "Inter", size: 12 }, boxWidth: 12, usePointStyle: true } },
        tooltip: { callbacks: {
          label: c => c.dataset.yAxisID === "y1"
            ? ` Net flow: ${c.parsed.y == null ? "—" : (c.parsed.y >= 0 ? "+" : "") + fmtInt(c.parsed.y)}`
            : ` Bonded weight: ${(+c.parsed.y).toFixed(2)}M`
        } }
      }
    }
  });

  document.getElementById("flowCap").innerHTML =
    (rows.length < 5
      ? "This panel started tracking on " + new Date(first.ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
        + ", so the trend is thin for now; it fills in with every daily reading. "
      : "")
    + "This is <b>net</b> flow: the day-over-day change in total bonded weight. Staking rewards are not auto-bonded on Realio "
    + "(they sit in the rewards pool until claimed), so a change here reflects real delegation activity, not compounding. "
    + "It cannot show <b>gross</b> staking and unstaking separately, a day with heavy churn in both directions that nets to "
    + "zero looks flat here. Read alongside the validator-concentration trend below for the fuller confidence picture: bonded "
    + "weight rising while concentration also rises is a different signal than both moving together the other way.";
}

/* Dollar value of the bonded base at current prices. Bonded weight is a mix of
   three denoms, so it has no single price: each denom's share of the
   multistaking pool is applied to bonded_weight (the pool also holds unbonding
   tokens) and priced separately. RIO is live from CoinGecko. DSTRX is listed
   there but trades thinly, so its price is shown as last reported. RST (Realio
   Security Token) has no public market price and is left unpriced rather than
   guessed, so the total is a floor. If CoinGecko is unreachable, RIO falls back
   to the price in the latest supply snapshot and DSTRX is dropped. */
/* $3.4M / $245k: compact so it fits beside the token amount. */
const usdShort = n => !isFinite(n) ? "—" : n >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? "$" + Math.round(n / 1e3) + "k" : "$" + Math.round(n);

const CG_IDS = { RIO: "realio-network", DSTRX: "districts" };

function renderBondedUsd(st) {
  const el = document.getElementById("bondedUsd");
  if (!el) return;
  const rows = st.pool_by_denom || [], pool = st.multistaking_pool_total;
  if (!rows.length || !pool) { el.textContent = ""; return; }
  const bonded = lbl => { const r = rows.find(x => x.label === lbl); return r ? r.amount * st.bonded_weight / pool : 0; };

  const paint = (prices, live) => {
    const parts = [];
    let total = 0;
    ["RIO", "DSTRX"].forEach(l => {
      const p = prices[l];
      if (typeof p !== "number") return;
      const v = bonded(l) * p;
      total += v;
      parts.push(l + " " + usdShort(v));
    });
    if (!parts.length) { el.textContent = ""; return; }
    // Floor: RST has no public price. Breakdown stays in the tooltip only.
    el.textContent = "(≥ " + usdShort(total) + ")";
    el.title = parts.join(" + ") + ", RST unpriced (no public market), at " + (live ? "current" : "last snapshot") + " prices";
  };

  getPrices().then(({ prices, live }) => paint(prices, live));
}

/* One CoinGecko call per page load, shared by the staking-flow chip and the
   base table. Resolves to { prices: {RIO, DSTRX}, live }. */
let PRICES_P = null;
function getPrices() {
  if (PRICES_P) return PRICES_P;
  PRICES_P = fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + Object.values(CG_IDS).join(",") + "&vs_currencies=usd")
    .then(r => { if (!r.ok) throw 0; return r.json(); })
    .then(d => {
      const prices = { RIO: (d[CG_IDS.RIO] || {}).usd, DSTRX: (d[CG_IDS.DSTRX] || {}).usd };
      if (typeof prices.RIO !== "number") throw 0;
      return { prices, live: true };
    })
    .catch(() => loadSupply().then(({ latest }) => ({ prices: { RIO: latest && latest.price_usd }, live: false })));
  return PRICES_P;
}

function renderConcentrationTrend(hist) {
  const el = document.getElementById("valTrend");
  if (!el) return;
  const rows = hist.filter(r => r.validators && typeof r.validators.nakamoto_coefficient === "number");
  if (rows.length < 2) { el.textContent = ""; return; }
  const first = rows[0].validators, last = rows[rows.length - 1].validators;
  const days = Math.max(1, Math.round((new Date(rows[rows.length - 1].ts) - new Date(rows[0].ts)) / 86400000));
  const dTop10 = last.top10_pct - first.top10_pct;
  el.innerHTML = `Over the last ${days} days: Nakamoto coefficient ${first.nakamoto_coefficient} → <b>${last.nakamoto_coefficient}</b>`
    + `, top 10 share ${first.top10_pct.toFixed(1)}% → <b>${last.top10_pct.toFixed(1)}%</b> `
    + `<span class="chg ${flowCls(-dTop10)}">(${dTop10 >= 0 ? "+" : ""}${dTop10.toFixed(1)}pp)</span>.`;
}

function loadNetwork() {
  return fetch("./network-history.json", { cache: "no-store" })
    .then(r => r.json())
    .then(arr => ({ hist: arr, latest: arr[arr.length - 1] }))
    .catch(() => ({ hist: [NET_FALLBACK], latest: NET_FALLBACK }));
}

loadNetwork().then(({ hist, latest: s }) => {
  renderLadder(s);
  renderBase(s);
  renderStakingFlow(hist);
  const stamp = document.getElementById("netUpdated");
  if (stamp && s.ts) stamp.textContent = new Date(s.ts)
    .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return fetch("./network-validators.json", { cache: "no-store" })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)
    .then(vd => { renderValidators(s, vd); renderConcentrationTrend(hist); });
});
