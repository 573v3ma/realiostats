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

    { v: pct2(y.after_max_commission) + "–" + pct2(y.after_min_commission), sub: "in your wallet", cls: "is-final",
      k: 'After validator commission <span class="rtag">what you receive</span>',
      x: "Your validator's cut comes off your share. Commission across the active set currently runs "
       + pct0(cMin) + " to " + pct0(cMax) + ", so where you delegate moves this by roughly "
       + ((y.after_min_commission && y.after_max_commission)
          ? (100 * (y.after_min_commission - y.after_max_commission)).toFixed(2) + " points"
          : "a fraction of a point") + "." }
  ];

  document.getElementById("ladder").innerHTML = rungs.map(r =>
    `<div class="rung ${r.cls}">
       <div><div class="rv">${r.v}</div><span class="rvsub">${r.sub}</span></div>
       <div><div class="rk">${r.k}</div><div class="rx">${r.x}</div></div>
     </div>`).join("");

  const gap = (y.official_apr && y.after_max_commission)
    ? (100 * (1 - y.after_max_commission / y.official_apr)).toFixed(0) : null;
  document.getElementById("ladderRead").innerHTML =
    "None of these numbers is wrong, and none of them contradicts the others. They measure "
    + "different points on the same chain of deductions, which is why quoting any single one "
    + "without its basis causes arguments. Between the headline APR and what lands in a wallet "
    + (gap ? "there is about a <b>" + gap + "% difference</b>" : "there is a material difference")
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
    + "with block time and the bonded base. Commission is the live range across the active set, not a promise about any one validator. "
    + "This is a yield figure, not part of the supply count.";
}

/* Why the yield is where it is: newly minted RIO is shared across a bonded base
   that is only about half RIO. Without this, the ladder looks arbitrary. */
function renderBase(s) {
  const st = s.staking || {}, rows = st.pool_by_denom || [];
  const max = Math.max(...rows.map(r => r.amount), 1);
  document.getElementById("baseBody").innerHTML = rows.map(r =>
    `<tr><td><span class="vbar" style="width:${Math.round(46 * r.amount / max)}px"></span>${r.label}</td>
         <td>${fmtM(M(r.amount))}</td><td>${r.pct_of_pool}%</td></tr>`).join("")
    + `<tr class="lq-total"><td>Multistaking pool</td><td>${fmtM(M(st.multistaking_pool_total))}</td><td>100%</td></tr>`;

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

function loadNetwork() {
  return fetch("./network-history.json", { cache: "no-store" })
    .then(r => r.json())
    .then(arr => arr[arr.length - 1])
    .catch(() => NET_FALLBACK);
}

loadNetwork().then(s => {
  renderLadder(s);
  renderBase(s);
  const stamp = document.getElementById("netUpdated");
  if (stamp && s.ts) stamp.textContent = new Date(s.ts)
    .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return fetch("./network-validators.json", { cache: "no-store" })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null)
    .then(vd => renderValidators(s, vd));
});
