/* realiostats — holders page. Liquid float by venue, per-chain holder
   base, EVM holder evolution, native holder evolution. Requires assets/core.js. */

// "Where the liquidity sits" section. Holdings come from holders.json, a dated
// snapshot of explorer labels (balances drift as exchanges rotate wallets, and
// name tags are not in any free API, so this is refreshed periodically, not
// live). Percentages ARE computed live against the current per-chain supply, so
// only the RIO amounts are as-of the snapshot date. Fails silently if the file
// is missing; the section just stays empty.
/* Tradable float ladder. computeFloat() lives in core.js because the supply
   page quotes the bottom rung too; one definition, one computation, so the two
   pages cannot drift into different numbers for the same thing. */
function renderFloatLadder(latest, h){
  const el = document.getElementById("floatLadder");
  if(!el || !h || !latest) return;
  const f = computeFloat(latest, h);
  const pc = n => f.circ ? (100*n/f.circ).toFixed(1)+"%" : "—";

  const rungs = [
    {v:fmtM(M(f.circ)), sub:"circulating", cls:"",
     k:"Every RIO that exists and can be traded",
     x:"Summed once across all seven chains, net of Realio-controlled reserve, treasury and bridge "
      +'wallets. This is the <a href="index.html">headline supply figure</a> and the correct denominator '
      +"for market cap. It is not a claim that all of it could be sold."},

    {v:fmtM(M(f.liquidChains)), sub:pc(f.liquidChains)+" of circ.", cls:"",
     k:"Sitting where the volume is",
     x:"RIO on BNB Chain and Ethereum, where essentially all real exchange and DEX volume settles. Fully "
      +"on-chain with no labelling judgement, but most of it sits in ordinary wallets rather than on a "
      +"venue, so it overstates what is sellable today."},

    {v:fmtM(M(f.onVenues)), sub:pc(f.onVenues)+" of circ.", cls:"",
     k:'Identified on a venue <span class="rtag grey">a floor</span>',
     x:"Exchange wallets plus DEX pool liquidity we could identify from public explorer name tags. Bridge "
      +"escrow is excluded: it backs wrapped RIO elsewhere and cannot be traded. Smaller labelled wallets "
      +"sit below the top holders, so the true figure is somewhat higher."},

    {v:fmtM(M(f.withMarket)), sub:"realistically tradable", cls:"is-final",
     k:'On a venue with an active market <span class="rtag">the practical float</span>',
     x:"The rung above, less the <b>"+fmtM(M(f.dead))+"</b> held on venues that list RIO but show no "
      +"active market, so that balance cannot presently be sold into. This is the number to hold next to "
      +"the market cap."}
  ];

  el.innerHTML = rungs.map(r =>
    `<div class="rung ${r.cls}">
       <div><div class="rv">${r.v}</div><span class="rvsub">${r.sub}</span></div>
       <div><div class="rk">${r.k}</div><div class="rx">${r.x}</div></div>
     </div>`).join("");

  const ratio = f.withMarket ? (f.circ/f.withMarket).toFixed(1) : null;
  document.getElementById("floatRead").innerHTML =
    "The gap between the top and bottom of that ladder is the point of this page. Circulating supply is "
    +(ratio ? "about <b>"+ratio+"x</b> " : "far ")
    +"the RIO identifiably sitting on a venue with a live market, so a relatively modest amount of buying "
    +"or selling moves the price more than the headline market cap implies. That cuts both ways: sharp "
    +"rallies on light volume, and equally sharp falls. It is also not fixed. Supply on the quieter chains "
    +"can bridge across over time, so today's thin float is a snapshot, not a permanent floor.";

  document.getElementById("floatCap").innerHTML =
    "Rungs 1 and 2 are read live on-chain each day. Rungs 3 and 4 come from <code>holders.json</code>, a "
    +"dated snapshot of public explorer name tags"
    +(h.as_of ? " last refreshed <b>"+h.as_of+"</b>" : "")
    +", because wallet labels are not in any free API and balances drift as venues rotate wallets. "
    +"Percentages are computed against the current live supply, so a dated numerator is divided by a live "
    +"denominator. Treat the bottom two rungs as a well-sourced lower bound rather than an exact total. "
    +"Circulating supply is unchanged by any of this: this section describes where that supply sits, not a "
    +"different supply figure.";
}

function renderHolders(latest, h){
  if(!h || !latest) return;
  renderFloatLadder(latest, h);
  const lq = document.getElementById("lqRead");
  if(lq){
    const f = computeFloat(latest, h);
    lq.innerHTML = "Circulating supply remains <b>"+fmtM(M(f.circ))+"</b>. Of that, <b>"
      +fmtM(M(f.liquidChains))+"</b> sits on the two liquid chains and <b>"+fmtM(M(f.withMarket))
      +"</b> is identifiably on a venue with an active market. Three different questions, three different "
      +"answers, and none of them changes the supply count.";
  }
  const bnb = (latest.chains && latest.chains.bnb &&
    (latest.chains.bnb.circulating ?? latest.chains.bnb.total_supply)) || 0;
  const circ = latest.tradable_total || 0;
  const body = document.getElementById("bscHoldersBody");
  if(body && Array.isArray(h.bsc_exchanges)){
    let tot = 0, wtot = 0;
    const rows = h.bsc_exchanges.slice().sort((a,b)=>b.rio-a.rio).map(x=>{
      tot += x.rio; wtot += x.wallets;
      const pB = bnb ? (100*x.rio/bnb).toFixed(1)+"%" : "—";
      const pC = circ ? (100*x.rio/circ).toFixed(1)+"%" : "—";
      const tag = x.note ? ` <span class="lq-tag">${x.note}</span>` : "";
      return `<tr><td>${x.entity}${tag}</td><td>${x.wallets}</td><td>${fmtM(M(x.rio))}</td><td>${pB}</td><td>${pC}</td></tr>`;
    }).join("");
    const tB = bnb ? (100*tot/bnb).toFixed(0)+"%" : "—";
    const tC = circ ? (100*tot/circ).toFixed(1)+"%" : "—";
    body.innerHTML = rows +
      `<tr class="lq-total"><td>Identified exchanges</td><td>${wtot}</td><td>${fmtM(M(tot))}</td><td>${tB}</td><td>${tC}</td></tr>`;
    document.getElementById("bscHoldersSub").innerHTML =
      `Held in exchange wallets, which custody user funds. Not exhaustive: smaller labelled wallets sit below the top holders, so the real exchange-held total is a little higher.`;
  }
  const eth = (latest.chains && latest.chains.ethereum &&
    (latest.chains.ethereum.circulating ?? latest.chains.ethereum.total_supply)) || 0;
  const ebody = document.getElementById("ethHoldersBody");
  if(ebody && Array.isArray(h.eth_holders)){
    let etot = 0;
    const rows = h.eth_holders.slice().sort((a,b)=>b.rio-a.rio).map(x=>{
      etot += x.rio;
      const pE = eth ? (100*x.rio/eth).toFixed(1)+"%" : "—";
      const pC = circ ? (100*x.rio/circ).toFixed(1)+"%" : "—";
      return `<tr><td>${x.holder}</td><td>${x.type}</td><td>${fmtM(M(x.rio))}</td><td>${pE}</td><td>${pC}</td></tr>`;
    }).join("");
    const tE = eth ? (100*etot/eth).toFixed(1)+"%" : "—";
    const tC = circ ? (100*etot/circ).toFixed(1)+"%" : "—";
    ebody.innerHTML = rows +
      `<tr class="lq-total"><td>Identified</td><td></td><td>${fmtM(M(etot))}</td><td>${tE}</td><td>${tC}</td></tr>`;
    document.getElementById("ethHoldersSub").textContent = h.eth_dispersed_note || "";
  }
  // Bridge throttles, read live from the snapshot. Two directions, stated
  // neutrally: the EVM mint cap is the gate for off-venue RIO reaching a
  // sellable venue; the native ratelimit governs the reverse flow.
  const bc = latest.bridge_caps || {};
  const capsEl = document.getElementById("lqCaps");
  const capM = v => { const m=v/1e6; return (m%1===0 ? m.toFixed(0) : m.toFixed(2).replace(/0+$/,"")) + "M"; };
  const evmB = bc.evm_daily_mint_cap_bnb, evmE = bc.evm_daily_mint_cap_eth, nat = bc.native_bridge_ratelimit;
  if(capsEl && (evmB || evmE)){
    const evmTxt = (evmB && evmE && evmB === evmE)
      ? "<b>"+capM(evmB)+" per day</b> onto each chain"
      : "<b>"+(evmB?capM(evmB):"n/a")+"/day</b> onto BNB Chain and <b>"+(evmE?capM(evmE):"n/a")+"/day</b> onto Ethereum";
    let t = "Getting off-venue RIO onto the liquid chains is throttled on-chain. Minting onto the EVM chains is capped at "+evmTxt+
            " (a mutable limit set by the bridge admin), so that is the real speed limit on supply reaching a major venue.";
    if(nat) t += " A separate <b>"+capM(nat)+" per day</b> limit governs the opposite flow, RIO bridging onto the native chain.";
    t += " Both are read live from the contracts and the bridge module.";
    capsEl.innerHTML = t;
    capsEl.hidden = false;
  }
  if(h.as_of){
    document.getElementById("lqCap").innerHTML =
      "Holdings as of "+h.as_of+", from "+(h.source||"public explorers")+". Balances drift as wallets rotate; verify live on "+
      '<a href="https://bscscan.com/token/0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0#balances" target="_blank" rel="noopener">BscScan</a> and '+
      '<a href="https://etherscan.io/token/0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0#balances" target="_blank" rel="noopener">Etherscan</a>. '+
      "Percentages are computed against the current live supply. Circulating supply is unchanged by any of this; the section describes distribution, not a different total.";
  }
}

// Holder base. A per-chain table (native read live each day; BNB reconstructed
// from full transfer history, refreshed separately; Ethereum likewise) plus
// a native evolution chart that accrues from the daily readings.
let HB_NATIVE = null, HB_EVM = null, HB_CHAINS = null;
function renderHolderTable(){
  const body = document.getElementById("hbTableBody");
  if(!body) return;
  const f = n => (n||0).toLocaleString("en-US");
  const g = (d,k) => d[k] == null ? '<td class="hb-na">n/a</td>' : `<td>${f(d[k])}</td>`;
  const row = (name,d) => d
    ? `<tr><td>${name}</td><td>${f(d.total)}</td><td>${f(d.gte_100)}</td><td>${f(d.gte_1k)}</td><td>${f(d.gte_10k)}</td>${g(d,"gte_100k")}</tr>`
    : `<tr><td>${name}</td><td colspan="5" class="hb-pending">being added</td></tr>`;
  const bnb = HB_EVM && HB_EVM.chains && HB_EVM.chains.bnb;
  const eth = HB_EVM && HB_EVM.chains && HB_EVM.chains.ethereum;
  const cx  = (HB_CHAINS && HB_CHAINS.chains) || {};
  const algo = cx.algorand, xlm = cx.stellar, sol = cx.solana, base = cx.base;
  const rows = [row("Realio Native", HB_NATIVE), row("BNB Chain", bnb), row("Ethereum", eth),
                row("Algorand", algo), row("Stellar", xlm), row("Solana", sol), row("Base", base)];
  const parts = [HB_NATIVE, bnb, eth, algo, xlm, sol, base].filter(Boolean);
  if(parts.length > 1){
    const sum = k => parts.reduce((a,d)=>a+(d[k]||0), 0);
    rows.push(`<tr class="lq-total"><td>Combined</td><td>${f(sum("total"))}</td><td>${f(sum("gte_100"))}</td><td>${f(sum("gte_1k"))}</td><td>${f(sum("gte_10k"))}</td><td>${f(sum("gte_100k"))}</td></tr>`);
  }
  body.innerHTML = rows.join("");
  const note = document.getElementById("hbTableNote");
  if(note){
    // Every row counts the same thing: addresses holding more than zero. The
    // per-chain method differs, so it is spelled out rather than implied.
    let t = "Every row counts addresses holding more than zero RIO, so the chains are comparable. "
      + "Realio Native counts each wallet's liquid + staked RIO (module accounts excluded), read live each day. "
      + "BNB Chain and Ethereum"
      + (HB_EVM && HB_EVM.as_of ? " as of " + HB_EVM.as_of : "")
      + ", each reconstructed from its full ERC-20 transfer history and reconciled against on-chain total supply. "
      + "Algorand, Stellar, Solana and Base"
      + (HB_CHAINS && HB_CHAINS.as_of ? " as of " + HB_CHAINS.as_of : "")
      + ", read from public keyless endpoints: asset balances on Algorand, accounts by asset on Stellar, "
      + "token accounts aggregated by owner on Solana, and transfer logs netted per address on Base.";
    if(xlm && xlm.trustlines) t += " Stellar shows " + f(xlm.trustlines)
      + " trustlines, but opening one costs nothing and most hold nothing, so only funded accounts are counted here.";
    if(base) t += " Base RIO is bridged from Ethereum under lock and mint, so it adds nothing to circulating supply: these are holder addresses only.";
    note.textContent = t;
  }
}

// EVM holder-base evolution (BNB + Ethereum), monthly since the Oct 2024
// migration. Reads chains.<c>.history from holders-evm.json, produced in one
// pass over each token's full transfer history. A metric toggle switches the
// threshold; both chains plot on a shared month axis.
let HB_EVM_CHART = null, HB_EVM_METRIC = "gte_100", HB_EVM_WIRED = false;
const HB_METRIC_LABEL = {gte_100:"100+ RIO", gte_1k:"1,000+ RIO", gte_10k:"10,000+ RIO", gte_100k:"100,000+ RIO", total:"All holders"};
function renderHolderEvm(){
  const card = document.getElementById("hbEvmCard"); if(!card) return;
  const cx = (HB_EVM && HB_EVM.chains) || {};
  // Base joins the two reconstructed chains: it is an EVM chain whose whole
  // transfer log fits in one public request, so its monthly history is free.
  // Algorand, Stellar and Solana stay out of this chart, snapshot only.
  const bx = (HB_CHAINS && HB_CHAINS.chains) || {};
  const have = [["Ethereum","#4f46e5", cx.ethereum && cx.ethereum.history],
                ["BNB Chain","#f0b90b", cx.bnb && cx.bnb.history],
                ["Base","#0052ff", bx.base && bx.base.history]]
               .filter(x => x[2] && x[2].length);
  if(!have.length){ card.hidden = true; return; }
  card.hidden = false;
  if(!HB_EVM_WIRED){
    document.querySelectorAll("#hbMetricRow .hb-mbtn").forEach(b => b.addEventListener("click", () => {
      HB_EVM_METRIC = b.dataset.m;
      document.querySelectorAll("#hbMetricRow .hb-mbtn").forEach(x => x.classList.toggle("is-on", x === b));
      renderHolderEvm();
    }));
    HB_EVM_WIRED = true;
  }
  const set = new Set(); have.forEach(([,,h]) => h.forEach(p => set.add(p.month)));
  const months = [...set].sort();
  const labels = months.map(m => { const [y,mo] = m.split("-");
    return new Date(y, mo-1, 1).toLocaleDateString("en-GB",{month:"short",year:"2-digit"}); });
  const series = have.map(([name,color,h]) => {
    const bym = {}; h.forEach(p => bym[p.month] = p[HB_EVM_METRIC]);
    return {name, color, data: months.map(m => bym[m] ?? null)};
  });
  const datasets = series.map(s => ({label:s.name, data:s.data, borderColor:s.color,
    backgroundColor:s.color+"22", tension:.25, pointRadius:0, borderWidth:1.8, fill:false, spanGaps:true}));
  // Combined line = both EVM chains summed for the selected tier, the global
  // trajectory. Drawn last so it sits on top; native is not included because it
  // has no reconstructable monthly history.
  if(series.length > 1){
    const combined = months.map((m,i) => {
      let sum = 0, any = false;
      series.forEach(s => { if(s.data[i] != null){ sum += s.data[i]; any = true; } });
      return any ? sum : null;
    });
    datasets.push({label:"Combined (" + series.map(s=>s.name).join(" + ") + ")", data:combined, borderColor:"#0b1015",
      backgroundColor:"transparent", tension:.25, pointRadius:0, borderWidth:2.4, fill:false, spanGaps:true});
  }
  if(HB_EVM_CHART) HB_EVM_CHART.destroy();
  HB_EVM_CHART = new Chart(document.getElementById("hbEvmCanvas"),{
    type:"line", plugins:[watermarkPlugin], data:{labels, datasets},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},
      scales:{
        y:{beginAtZero:true,grid:{color:"#eef1f4"},ticks:{color:"#69747f",font:{family:"Inter"}}},
        x:{grid:{display:false},ticks:{color:"#69747f",font:{family:"Inter",size:11},maxRotation:0,autoSkipPadding:14}}
      },
      plugins:{
        legend:{labels:{color:"#0b1015",font:{family:"Inter",size:12},boxWidth:12,usePointStyle:true}},
        tooltip:{callbacks:{title:i => i[0].label + " · " + HB_METRIC_LABEL[HB_EVM_METRIC]}}
      }
    }
  });
}

// Native holder evolution. Same metric toggle as the EVM chart, but a single
// Realio Native line. Native cannot be reconstructed historically (no cheap
// Cosmos historical holder query), so it is counted forward only from the first
// daily reading and grows one point per day.
let HB_NAT_METRIC = "gte_100", HB_NAT_CHART = null, HB_NAT_WIRED = false, HB_NAT_PTS = [];
function renderNativeChart(){
  const card = document.getElementById("hbChartCard"); if(!card) return;
  const building = document.getElementById("hbBuilding");
  const pts = HB_NAT_PTS;
  if(!pts.length){ card.hidden = true; if(building) building.hidden = false; return; }
  card.hidden = false; if(building) building.hidden = true;
  if(!HB_NAT_WIRED){
    document.querySelectorAll("#hbNativeMetricRow .hb-mbtn").forEach(b => b.addEventListener("click", () => {
      HB_NAT_METRIC = b.dataset.m;
      document.querySelectorAll("#hbNativeMetricRow .hb-mbtn").forEach(x => x.classList.toggle("is-on", x === b));
      renderNativeChart();
    }));
    HB_NAT_WIRED = true;
  }
  const labels = pts.map(s => new Date(s.ts).toLocaleDateString("en-GB",{day:"numeric",month:"short"}));
  const data = pts.map(s => s.native_holders[HB_NAT_METRIC]);
  if(HB_NAT_CHART) HB_NAT_CHART.destroy();
  HB_NAT_CHART = new Chart(document.getElementById("holdersCanvas"),{
    type:"line",
    plugins:[watermarkPlugin],
    data:{labels, datasets:[{label:"Native, " + HB_METRIC_LABEL[HB_NAT_METRIC], data,
      borderColor:"#10b981", backgroundColor:"#10b98122", tension:.25, pointRadius:3,
      pointBackgroundColor:"#10b981", fill:false, borderWidth:1.8}]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},
      scales:{
        y:{beginAtZero:true,grid:{color:"#eef1f4"},ticks:{color:"#69747f",font:{family:"Inter"}}},
        x:{grid:{display:false},ticks:{color:"#69747f",font:{family:"Inter",size:11},maxRotation:0,autoSkipPadding:14}}
      },
      plugins:{legend:{labels:{color:"#0b1015",font:{family:"Inter",size:12},boxWidth:12,usePointStyle:true}}}
    }
  });
}
function renderHolderBase(arr){
  const pts = (arr||[]).filter(s=>s.native_holders && typeof s.native_holders.total === "number");
  if(pts.length){ HB_NATIVE = pts[pts.length-1].native_holders; }
  renderHolderTable();
  HB_NAT_PTS = pts;
  renderNativeChart();
}

loadSupply().then(({arr, latest})=>{
  // Native holder counts and the native evolution chart come from the same
  // daily snapshot series the supply page uses.
  renderHolderBase(arr);
  // Liquidity/holders snapshot file, percentages computed live. Silent if absent.
  fetch("./holders.json",{cache:"no-store"}).then(r=>r.ok?r.json():null)
    .then(h=>renderHolders(latest,h)).catch(()=>{});
  // EVM holder counts (reconstructed, refreshed separately). Fills the BNB/ETH
  // rows once loaded; native already rendered from the daily snapshot.
  fetch("./holders-evm.json",{cache:"no-store"}).then(r=>r.ok?r.json():null)
    .then(e=>{ HB_EVM = e; renderHolderTable(); renderHolderEvm(); }).catch(()=>{});
  // Algorand, Stellar, Solana and Base, read from public keyless endpoints.
  // Fills their table rows, and adds the Base line to the EVM chart.
  fetch("./holders-chains.json",{cache:"no-store"}).then(r=>r.ok?r.json():null)
    .then(c=>{ HB_CHAINS = c; renderHolderTable(); renderHolderEvm(); }).catch(()=>{});
});
