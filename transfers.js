/* realiostats — large transfers (holders page). Every RIO transfer of
   100,000+ RIO in the last 30 days, all seven chains, from
   large-transfers.json (written daily by fetch_large_transfers.py), topped up
   with /api/live-transfers (the realiostats-live Worker, checked every minute)
   for anything that moved since the daily run.
   Self-contained: needs only the page markup, not core.js internals. */
(function(){
  const CHAINS = {
    native:   {name:"Realio Native", tx:"https://explorer.realio.network/transactions/", addr:"https://explorer.realio.network/accounts/"},
    bnb:      {name:"BNB Chain", tx:"https://bscscan.com/tx/", addr:"https://bscscan.com/address/"},
    eth:      {name:"Ethereum", tx:"https://etherscan.io/tx/", addr:"https://etherscan.io/address/"},
    base:     {name:"Base", tx:"https://basescan.org/tx/", addr:"https://basescan.org/address/"},
    solana:   {name:"Solana", tx:"https://solscan.io/tx/", addr:"https://solscan.io/account/"},
    algorand: {name:"Algorand", tx:"https://allo.info/tx/", addr:"https://allo.info/account/"},
    stellar:  {name:"Stellar", tx:"https://stellar.expert/explorer/public/tx/", addr:"https://stellar.expert/explorer/public/account/"}
  };
  const ORDER = ["native","bnb","eth","base","solana","algorand","stellar"];
  const TYPES = {
    all:      {name:"All types", kinds:null},
    exchange: {name:"Exchange flows", kinds:["deposit","withdrawal","exchange"]},
    bridge:   {name:"Bridges and IBC", kinds:["bridge_out","bridge_in","ibc_out","ibc_in","mint","burn"]},
    wallet:   {name:"Wallets and DEX", kinds:["wallet","dex"]}
  };
  const PAGE = 40;
  let DATA = null, LIVE = null, fChain = "all", fType = "all", showAll = false;

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const num = n => Math.round(n).toLocaleString("en-US");
  const short = a => a.length > 16 ? a.slice(0, 6) + "…" + a.slice(-4) : a;
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const when = ts => { const d = new Date(ts*1000);
    return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`; };
  const day = ts => { const d = new Date(ts*1000); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const chainOf = id => (id || "").split(":")[0];

  function addrUrl(chain, a){
    if(/^osmo1/.test(a)) return "https://www.mintscan.io/osmosis/address/" + a;
    if(chain === "stellar" && !/^G/.test(a)) return null;      // pools, muxed: no account page
    if(chain === "solana" && /^account#/.test(a)) return null;
    return CHAINS[chain].addr + a;
  }
  function party(r, side){
    const a = r[side], label = r[side + "_label"];
    const url = (a && !/^(MINT|BURN|ISSUER)$/.test(a)) ? addrUrl(r.chain, a) : null;
    const text = label ? `<b style="font-weight:600">${esc(label)}</b>` : `<span style="color:var(--muted)">${esc(short(a || ""))}</span>`;
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(a)}" style="text-decoration:none">${text}</a>` : text;
  }
  function kindLabel(r){
    const other = r.pair ? (CHAINS[chainOf(r.pair)] || {}).name : null;
    switch(r.kind){
      case "bridge_out": return other ? `Bridge to ${other}` : "Bridge out";
      case "bridge_in":  return other ? `Bridge from ${other}` : "Bridge in";
      case "ibc_out":    return "IBC out";
      case "ibc_in":     return "IBC in";
      case "deposit":    return "Exchange deposit";
      case "withdrawal": return "Exchange withdrawal";
      case "exchange":   return "Exchange internal";
      case "dex":        return "DEX";
      case "mint":       return "Issuer mint";
      case "burn":       return "Issuer burn";
      default:           return "Wallet to wallet";
    }
  }
  function filtered(){
    const kinds = TYPES[fType].kinds;
    return DATA.transfers.filter(r => (fChain === "all" || r.chain === fChain) && (!kinds || kinds.includes(r.kind)));
  }

  function renderFilters(){
    const all = DATA.transfers;
    const cnt = c => all.filter(r => r.chain === c).length;
    const cb = document.getElementById("ltChainRow");
    cb.innerHTML = [`<button type="button" class="hb-mbtn${fChain==="all"?" is-on":""}" data-c="all">All chains (${all.length})</button>`]
      .concat(ORDER.map(c => `<button type="button" class="hb-mbtn${fChain===c?" is-on":""}" data-c="${c}">${CHAINS[c].name} (${cnt(c)})</button>`)).join("");
    const tb = document.getElementById("ltTypeRow");
    tb.innerHTML = Object.keys(TYPES).map(k => `<button type="button" class="hb-mbtn${fType===k?" is-on":""}" data-t="${k}">${TYPES[k].name}</button>`).join("");
  }

  function renderSummary(rows){
    const el = document.getElementById("ltSummary");
    const sum = ks => rows.filter(r => ks.includes(r.kind)).reduce((a, r) => a + r.amount, 0);
    const n = ks => rows.filter(r => ks.includes(r.kind)).length;
    const total = rows.reduce((a, r) => a + r.amount, 0);
    const txs = new Set(rows.map(r => r.chain + r.tx)).size;
    if(!rows.length){ el.textContent = "No transfers of this size match the filter in the window."; return; }
    const parts = [`<b>${num(rows.length)}</b> transfers in ${num(txs)} transactions, <b>${num(total)} RIO</b> moved.`];
    if(n(["deposit"]))    parts.push(`Into exchanges: ${num(sum(["deposit"]))} RIO (${n(["deposit"])}).`);
    if(n(["withdrawal"])) parts.push(`Out of exchanges: ${num(sum(["withdrawal"]))} RIO (${n(["withdrawal"])}).`);
    const br = ["bridge_out","bridge_in"];
    if(n(br)) parts.push(`Bridge legs: ${n(br)} (each bridge move shows once per chain).`);
    el.innerHTML = parts.join(" ");
  }

  function renderTable(){
    const rows = filtered();
    renderSummary(rows);
    const body = document.getElementById("ltBody");
    const shown = showAll ? rows : rows.slice(0, PAGE);
    let prevTx = null;
    body.innerHTML = shown.length ? shown.map(r => {
      const same = prevTx === r.chain + r.tx; prevTx = r.chain + r.tx;
      const t = same ? `<span style="color:var(--faint);font-weight:400">same tx</span>`
                     : `${r.time_est ? "≈ " : ""}${when(r.ts)}${r.live ? ` <span class="lt-new" title="Found by the live check, added to the full list at the next daily update">new</span>` : ""}`;
      const txUrl = CHAINS[r.chain].tx + r.tx;
      return `<tr><td>${t}</td><td style="text-align:left">${CHAINS[r.chain].name}</td>`
        + `<td>${num(r.amount)}</td><td style="text-align:left">${party(r,"from")}</td>`
        + `<td style="text-align:left">${party(r,"to")}</td>`
        + `<td style="text-align:left"><span class="lq-tag" style="margin-left:0">${esc(kindLabel(r))}</span></td>`
        + `<td><a href="${esc(txUrl)}" target="_blank" rel="noopener" title="${esc(r.tx)}">${esc(short(r.tx))}</a></td></tr>`;
    }).join("") : `<tr><td colspan="7" class="hb-pending">No transfers of 100,000+ RIO match this filter.</td></tr>`;
    const more = document.getElementById("ltMore");
    more.hidden = rows.length <= PAGE;
    more.textContent = showAll ? "Show fewer" : `Show all ${rows.length}`;
  }

  function renderNotes(){
    const ch = DATA.chains || {};
    const ws = Date.parse(DATA.window_start) / 1000;
    const late = ORDER.filter(c => ch[c] && ch[c].coverage_from && ch[c].coverage_from > ws + 86400)
      .map(c => `${CHAINS[c].name} from ${day(ch[c].coverage_from)}`);
    const stale = ORDER.filter(c => !ch[c] || !["ok","partial"].includes(ch[c].status)).map(c => CHAINS[c].name);
    const partial = ORDER.filter(c => ch[c] && ch[c].status === "partial").map(c => CHAINS[c].name);
    const asOf = DATA.as_of ? `${day(Date.parse(DATA.as_of)/1000)} ${DATA.as_of.slice(11,16)} UTC` : "n/a";
    const bits = [`Window: last ${DATA.window_days} days, updated ${asOf}.`];
    if(late.length) bits.push(`Coverage starts later on ${late.join(", ")}: the free public endpoints keep only part of the history, so the 30-day window fills forward day by day.`);
    if(partial.length) bits.push(`Still catching up on ${partial.join(", ")}: its most recent days are added over the next daily runs.`);
    if(stale.length) bits.push(`Not refreshed on the latest run: ${stale.join(", ")}. Rows shown for it are from the last good run.`);
    if(LIVE) bits.push(LIVE.fresh
      ? `Live check: ${LIVE.fresh} newer transfer${LIVE.fresh === 1 ? "" : "s"} marked new, last checked ${LIVE.at} UTC.`
      : `Live check: nothing new since the daily update, last checked ${LIVE.at} UTC.`);
    if(DATA.transfers.some(r => r.time_est)) bits.push(`≈ marks a native-chain time estimated from the block rate.`);
    document.getElementById("ltNote").textContent = bits.join(" ");
  }

  function render(){ renderFilters(); renderTable(); }

  function init(){
    const sec = document.getElementById("transfers");
    if(!sec) return;
    document.getElementById("ltChainRow").addEventListener("click", e => {
      const b = e.target.closest("[data-c]"); if(!b) return; fChain = b.dataset.c; showAll = false; render(); });
    document.getElementById("ltTypeRow").addEventListener("click", e => {
      const b = e.target.closest("[data-t]"); if(!b) return; fType = b.dataset.t; showAll = false; render(); });
    document.getElementById("ltMore").addEventListener("click", () => { showAll = !showAll; renderTable(); });
    const getJ = u => fetch(u, {cache:"no-store"}).then(r => r.ok ? r.json() : null).catch(() => null);
    Promise.all([getJ("./large-transfers.json"), getJ("/api/live-transfers")]).then(([d, live]) => {
      if(!d || !Array.isArray(d.transfers)) throw new Error("no data");
      // Same merge as the homepage card: drop live rows the daily file already has.
      const key = t => t.chain + "|" + String(t.tx).toLowerCase() + "|" + Math.round(t.amount);
      const seen = new Set(d.transfers.map(t => t.id));
      d.transfers.forEach(t => seen.add(key(t)));
      const chk = live && Date.parse(live.checked);
      if(chk && Date.now() - chk < 10 * 6e4 && Array.isArray(live.transfers)){
        const fresh = live.transfers.filter(t => t && t.ts && CHAINS[t.chain] && !seen.has(t.id) && !seen.has(key(t)))
          .map(t => Object.assign({}, t, {live: true}));
        d.transfers = d.transfers.concat(fresh).sort((a, b) => b.ts - a.ts);
        LIVE = {fresh: fresh.length, at: new Date(chk).toISOString().slice(11, 16)};
      }
      DATA = d; render(); renderNotes();
    }).catch(() => {
      document.getElementById("ltBody").innerHTML = `<tr><td colspan="7" class="hb-pending">Transfer data could not be loaded.</td></tr>`;
    });
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
