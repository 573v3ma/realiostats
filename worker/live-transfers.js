/*
 * realiostats live large transfers (Cloudflare Worker).
 *
 * The daily GitHub job (fetch_large_transfers.py) keeps the full 30-day list in
 * large-transfers.json. This Worker only fills the gap since that file was
 * written: a cron trigger runs every minute, reads the new blocks on all seven
 * chains from the per-chain cursor it keeps in D1, and stores any transfer of
 * 100,000 RIO or more for 48 hours. The homepage merges both lists.
 *
 *   GET /api/live-transfers  -> {as_of, threshold_rio, chains, transfers}
 *
 * Same chains, contracts, endpoints, ids, labels and transfer kinds as the
 * Python job (ids match, so the merge never shows a row twice). Bridge legs are
 * not paired here; the daily job does that. Keyless public endpoints only.
 * Each chain fails on its own and keeps its cursor; the daily job remains the
 * backstop for anything a public endpoint missed.
 */

const THRESHOLD = 100_000;
const KEEP_S = 48 * 3600;
const UA = "realiostats-live/0.1 (+https://realiostats.com)";
const SITE = "https://realiostats.com";

const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_EVM = "0x0000000000000000000000000000000000000000";
const EVM = {
  // span = blocks per eth_getLogs call, calls = per minute, behind = deepest catch-up.
  // Measured from Cloudflare 8 Nov 2026: shared Worker IPs get 429s from most
  // public RPCs; publicnode BNB answers 1,000-block ranges, not 10,000.
  // With ALCHEMY_*_URL secrets set, Alchemy is used first (no range cap).
  bnb: {c: "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0", dec: 18, calls: 6, behind: 350_000, init: 1_400,
        rpcs: [["https://bsc-rpc.publicnode.com", 1_000], ["https://rpc-bsc.48.club", 500]]},
  eth: {c: "0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0", dec: 18, calls: 2, behind: 50_000, init: 50,
        rpcs: [["https://rpc.mevblocker.io", 10_000], ["https://ethereum-rpc.publicnode.com", 1_000]]},
  base: {c: "0x5e64c9049455b3bb6e9fbdc33565fa313bae9b53", dec: 18, calls: 3, behind: 200_000, init: 300,
         rpcs: [["https://base-rpc.publicnode.com", 2_000], ["https://base.gateway.tenderly.co", 1_000]]},
};
const BASE_L1_BRIDGE = "0x3154cf16ccdb4c6d922629664174b904d80f2c35";
const BASE_L2_BRIDGE = "0x4200000000000000000000000000000000000010";

const SOL_MINT = "HELn8rSM1rp8vAjNH4NYXzX6FvCbwWMGqLfaMgiBnZFV";
const SOL_DEC = 11;
const SOL_MAX = 10;                       // getTransaction calls per minute
const SOL_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];

const ALGO_ASA = 2751733;
const ALGO_DEC = 7;
const ALGO_IDX = ["https://mainnet-idx.algonode.cloud", "https://mainnet-idx.4160.nodely.dev"];

const STELLAR_ISSUER = "GBNLJIYH34UWO5YZFA3A3HD3N76R6DOI33N4JONUOHEEYZYCAYTEJ5AK";
const STELLAR_SAC = "CB2XLDU74PIXO5DENULX53IIC3DMKGN2UM5IBGMSSI634IAQJ7O3Z3UQ";   // stellar_sac_id("RIO", issuer)
const STELLAR_DEC = 7;
const STELLAR_RPCS = ["https://rpc.lightsail.network", "https://soroban-rpc.mainnet.stellar.gateway.fm",
                      "https://mainnet.sorobanrpc.com"];

const NATIVE_RPC = "https://rpc.realio.network";
const NATIVE_HASURA = "https://hasura.realio.network/v1/graphql";
const NATIVE_LCDS = ["https://realio-api.noders.services", "https://rest.cosmos.directory/realio"];
const NATIVE_DEC = 18;
const NATIVE_MAX_BLOCKS = 900;            // heights per minute while catching up
const NATIVE_SKIP_MODULES = new Set(["bonded_tokens_pool", "not_bonded_tokens_pool", "distribution",
                                     "fee_collector", "multistaking", "mint", "gov"]);

const STATIC_LABELS = {
  eth: {[BASE_L1_BRIDGE]: ["Base bridge (escrow)", "bridge"]},
  base: {[BASE_L2_BRIDGE]: ["Base bridge", "bridge"]},
  algorand: {
    GNRGAOG65JPGWVIK2Q45R4XLLVIMF7AWVBK5TEBGWRRAZ3EHPQIN44EGFA: ["Realio reserve", "team"],
    M3IAMWFYEIJWLWFIIOEDFOLGIVMEOB3F4I3CA4BIAHJENHUUSX63APOXXM: ["MEXC custody (retired)", "exchange"],
    ZEJPIFQF5MSDOB3YA6OUG4S26FFX64SCTHKDMYCCB26JGG7DC4IPBWQSLQ: ["MEXC hot wallet", "exchange"],
    O5PL7CXYDK3TLGKSDTABLABYDZYM55UMS34P4RJEE3WABW45QI2JFC7OCA: ["Reissue return wallet", "team"],
    RCES4II33PXVDX4ISQ3TWUZN5DP7JM6ZTDBJLARYQH53O4OLN5QTNYUJ6A: ["25 Aug 2026 attacker", "attacker"],
  },
  stellar: {
    [STELLAR_ISSUER]: ["RIO issuer", "issuer"],
    GBRKMQ4IO5UURRRFLGLDIWBOWEF7ENC2BU5PB26ATAQRSWIZALE5EW2L: ["Realio treasury", "team"],
    GBDMMICWFVSSU5YIKIVWG6EP3U65R2GIF7BICN3JIBES5NVGFZFLWXKZ: ["25 Aug 2026 attacker", "attacker"],
  },
  native: {
    realio1uzkdrfnjv53rt0cf4ltszffpd7mvkpd2cv794j: ["25 Aug 2026 attacker", "attacker"],
    realio1usws4ccu3m7ln6m5gesc3m8jqcl0fqagq32kv6: ["Bridge relayer", "bridge"],
  },
};
const IBC_PREFIX = {osmo: "Osmosis", cosmos: "Cosmos Hub", noble: "Noble", neutron: "Neutron",
                    axelar: "Axelar", kava: "Kava", evmos: "Evmos", juno: "Juno"};

/* ------------------------------------------------------------- helpers */
const now = () => Math.floor(Date.now() / 1000);
const hex = n => "0x" + n.toString(16);
const parseIso = s => Math.floor(Date.parse(s.endsWith("Z") ? s : s + "Z") / 1000);

function units(v, dec) {                  // BigInt base units -> number, 2 decimals
  const s = 10n ** BigInt(dec);
  return Number((v * 100n + s / 2n) / s) / 100;
}

async function getJ(url, opt = {}) {
  const r = await fetch(url, {headers: {"user-agent": UA, accept: "application/json"},
                              signal: AbortSignal.timeout(opt.timeout || 20000), cf: opt.cf});
  if (!r.ok) throw new Error(`GET ${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}

async function rpc(url, method, params, timeout = 20000) {
  const r = await fetch(url, {method: "POST", signal: AbortSignal.timeout(timeout),
    headers: {"content-type": "application/json", "user-agent": UA},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})});
  if (!r.ok) throw new Error(`${method} ${new URL(url).host} HTTP ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(`${method} ${new URL(url).host}: ${JSON.stringify(d.error).slice(0, 160)}`);
  return d.result;
}

/* ------------------------------------------------------------- EVM */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function alchemyUrl(chain, env) {          // same secrets and Base derivation as the Python job
  const eth = (env.ALCHEMY_ETH_URL || "").trim();
  if (chain === "bnb") return (env.ALCHEMY_BNB_URL || "").trim() || null;
  if (chain === "eth") return eth || null;
  if (chain === "base") return (env.ALCHEMY_BASE_URL || "").trim() ||
    (eth.includes("eth-mainnet.g.alchemy.com") ? eth.replace("eth-mainnet.g.alchemy.com", "base-mainnet.g.alchemy.com") : null);
  return null;
}

async function evmAlchemy(chain, url, cur) {   // errors name the host only: the key is in the URL path
  const C = EVM[chain];
  const head = parseInt(await rpc(url, "eth_blockNumber", []), 16) - 3;
  let start = cur != null ? Number(cur) + 1 : head - C.init;
  if (head - start > C.behind) start = head - C.behind;
  if (start > head) return {rows: [], cursor: cur ?? head, source: "alchemy"};
  let rows = [], page = null, cursor = head;
  for (let i = 0; i < 5; i++) {
    const q = {fromBlock: hex(start), toBlock: hex(head), contractAddresses: [C.c], category: ["erc20"],
               withMetadata: true, excludeZeroValue: true, maxCount: "0x3e8", order: "asc"};
    if (page) q.pageKey = page;
    const res = await rpc(url, "alchemy_getAssetTransfers", [q], 30000);
    for (const t of res.transfers || []) {
      const raw = (t.rawContract || {}).value;
      if (!raw) continue;
      const amt = units(BigInt(raw), C.dec);
      if (amt < THRESHOLD) continue;
      let li = String(t.uniqueId || "").split(":").pop();
      li = li.startsWith("0x") ? parseInt(li, 16) : (/^\d+$/.test(li) ? parseInt(li, 10) : 0);
      const ts = t.metadata && t.metadata.blockTimestamp;
      rows.push({id: `${chain}:${t.hash}:${li}`, chain, ts: ts ? Math.floor(Date.parse(ts) / 1000) : null, amount: amt,
                 from: (t.from || ZERO_EVM).toLowerCase(), to: (t.to || ZERO_EVM).toLowerCase(),
                 tx: t.hash, block: parseInt(t.blockNum, 16)});
    }
    page = res.pageKey;
    if (!page) break;
  }
  if (page && rows.length) {               // very busy stretch: finish the last block next minute
    cursor = Math.max(...rows.map(r => r.block)) - 1;
    rows = rows.filter(r => r.block <= cursor);
  }
  return {rows, cursor, behind: head - cursor, source: "alchemy"};
}

async function evmKeyless(chain, cur, calls) {
  const C = EVM[chain], errs = [];
  for (const [url, span] of C.rpcs) {
    const host = new URL(url).host;
    let head;
    try { head = parseInt(await rpc(url, "eth_blockNumber", []), 16) - 3; }   // small reorg margin
    catch (e) { errs.push(String(e.message || e)); continue; }
    let start = cur != null ? Number(cur) + 1 : head - C.init, gap = false;
    if (head - start > C.behind) { start = head - C.behind; gap = true; }
    if (start > head) return {rows: [], cursor: cur ?? head, source: host};
    const end = Math.min(head, start + span * calls - 1);
    const rows = [], tsCache = {};
    let done = start - 1;
    try {
      for (let s = start; s <= end; s += span) {
        if (s > start) await sleep(1000);     // public RPCs throttle bursts
        const e = Math.min(end, s + span - 1);
        const logs = await rpc(url, "eth_getLogs",
          [{address: C.c, topics: [TOPIC], fromBlock: hex(s), toBlock: hex(e)}], 30000);
        for (const lg of logs) {
          if (lg.removed || !lg.data || lg.data === "0x") continue;
          const amt = units(BigInt(lg.data), C.dec);
          if (amt < THRESHOLD) continue;
          const n = parseInt(lg.blockNumber, 16);
          let ts = lg.blockTimestamp ? parseInt(lg.blockTimestamp, 16) : tsCache[n];
          if (!ts) {
            const b = await rpc(url, "eth_getBlockByNumber", [hex(n), false]);
            ts = tsCache[n] = parseInt(b.timestamp, 16);
          }
          rows.push({id: `${chain}:${lg.transactionHash}:${parseInt(lg.logIndex, 16)}`, chain, ts,
                     amount: amt, from: "0x" + lg.topics[1].slice(-40), to: "0x" + lg.topics[2].slice(-40),
                     tx: lg.transactionHash, block: n});
        }
        done = e;
      }
    } catch (e) {
      errs.push(String(e.message || e));
      if (done < start) continue;             // nothing read here: try the next RPC
    }
    return {rows, cursor: done, behind: head - done, source: host, gap,
            note: gap ? "skipped blocks beyond keyless depth" : done < end ? "partial: " + errs[errs.length - 1].slice(0, 140) : undefined};
  }
  throw new Error(errs.join(" | ").slice(0, 400));
}

async function scanEvm(chain, cur, opt = {}, env = {}) {
  const au = alchemyUrl(chain, env);
  if (au) {
    try { return await evmAlchemy(chain, au, cur); } catch (e) { /* fall back to public RPCs */ }
  }
  return evmKeyless(chain, cur, opt.calls || EVM[chain].calls);
}

/* ------------------------------------------------------------- Solana */
async function solTx(url, sig) {
  try {
    return await rpc(url, "getTransaction", [sig, {encoding: "jsonParsed", maxSupportedTransactionVersion: 1}]);
  } catch (e) {
    if (!/version/i.test(String(e))) throw e;
    return rpc(url, "getTransaction", [sig, {encoding: "jsonParsed", maxSupportedTransactionVersion: 0}]);
  }
}

async function scanSolana(cur, opt = {}) {
  const max = opt.max || SOL_MAX;
  let lastErr;
  for (const url of SOL_RPCS) {
    try {
      if (!cur) {             // no cursor yet: start from the newest signature
        const p = await rpc(url, "getSignaturesForAddress", [SOL_MINT, {limit: 1}]);
        return {rows: [], cursor: p[0] ? p[0].signature : null, source: new URL(url).host};
      }
      const page = await rpc(url, "getSignaturesForAddress", [SOL_MINT, {limit: 100, until: cur}]);
      const ordered = page.slice().reverse();          // oldest first
      const todo = ordered.slice(0, max);
      const rows = [];
      for (const s of todo) {
        if (s.err) continue;
        const tx = await solTx(url, s.signature);
        if (!tx || !tx.meta || tx.meta.err) continue;
        const delta = {};
        for (const [key, sign] of [["preTokenBalances", -1n], ["postTokenBalances", 1n]]) {
          for (const b of tx.meta[key] || []) {
            if (b.mint !== SOL_MINT) continue;
            const o = b.owner || `account#${b.accountIndex}`;
            delta[o] = (delta[o] || 0n) + sign * BigInt(b.uiTokenAmount.amount);
          }
        }
        const ent = Object.entries(delta);
        if (!ent.length) continue;
        const net = ent.reduce((a, [, v]) => a + v, 0n);
        const neg = ent.filter(([, v]) => v < 0n).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
        const pos = ent.filter(([, v]) => v > 0n).sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0));
        const outAmt = units(-neg.reduce((a, [, v]) => a + v, 0n), SOL_DEC);
        const inAmt = units(pos.reduce((a, [, v]) => a + v, 0n), SOL_DEC);
        const amt = Math.max(outAmt, inAmt);
        if (amt < THRESHOLD) continue;
        let frm = neg.length ? neg[0][0] : "MINT", to = pos.length ? pos[0][0] : "BURN";
        if (net > 0n && neg.length) frm = "MINT";
        if (net < 0n && pos.length) to = "BURN";
        rows.push({id: `solana:${s.signature}`, chain: "solana", ts: tx.blockTime || s.blockTime,
                   amount: amt, from: frm, to, tx: s.signature, block: tx.slot});
      }
      const last = todo.length ? todo[todo.length - 1].signature : cur;
      return {rows, cursor: last, behind: ordered.length - todo.length, source: new URL(url).host};
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ------------------------------------------------------------- Algorand */
function* algoFlatten(t, rootId, path = "") {
  yield [t, rootId + path];
  const inner = t["inner-txns"] || [];
  for (let i = 0; i < inner.length; i++) yield* algoFlatten(inner[i], rootId, `${path}/inner/${i + 1}`);
}

async function scanAlgorand(cur) {
  const raw = THRESHOLD * 10 ** ALGO_DEC;
  let lastErr;
  for (const base of ALGO_IDX) {
    try {
      const q = new URLSearchParams({"currency-greater-than": String(raw - 1), limit: "1000"});
      if (cur != null) q.set("min-round", String(Number(cur) + 1));
      else q.set("after-time", new Date((now() - 600) * 1000).toISOString().slice(0, 19) + "Z");
      const rows = [];
      let current = null, token = null;
      for (let page = 0; page < 5; page++) {
        if (token) q.set("next", token);
        const d = await getJ(`${base}/v2/assets/${ALGO_ASA}/transactions?${q}`);
        current = d["current-round"] ?? current;
        for (const root of d.transactions || []) {
          for (const [t, tid] of algoFlatten(root, root.id)) {
            const a = t["asset-transfer-transaction"];
            if (t["tx-type"] !== "axfer" || !a || a["asset-id"] !== ALGO_ASA) continue;
            const frm = a.sender || t.sender;
            for (const [amtRaw, to, suf] of [[a.amount || 0, a.receiver, ""], [a["close-amount"] || 0, a["close-to"], ":close"]]) {
              if (!to || amtRaw < raw) continue;
              rows.push({id: `algorand:${tid}${suf}`, chain: "algorand", ts: root["round-time"],
                         amount: Math.round(amtRaw / 10 ** (ALGO_DEC - 2)) / 100, from: frm, to,
                         tx: root.id, block: root["confirmed-round"]});
            }
          }
        }
        token = d["next-token"];
        if (!token || !(d.transactions || []).length) { token = null; break; }
      }
      if (token) {            // unusual burst: resume from the last full round next minute
        const last = Math.max(...rows.map(r => r.block));
        return {rows: rows.filter(r => r.block < last), cursor: last - 1, source: new URL(base).host};
      }
      return {rows, cursor: current ?? cur, source: new URL(base).host};
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ------------------------------------------------------------- Stellar (XDR, no SDK) */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function crc16(d) {
  let c = 0;
  for (const b of d) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = (c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1) & 0xffff;
  }
  return c;
}
function strkey(ver, payload) {
  const d = new Uint8Array(payload.length + 3);
  d[0] = ver; d.set(payload, 1);
  const c = crc16(d.subarray(0, payload.length + 1));
  d[payload.length + 1] = c & 0xff; d[payload.length + 2] = c >> 8;
  let out = "", bits = 0, val = 0;
  for (const b of d) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
const b64bytes = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

class Xdr {
  constructor(b64) { this.b = b64bytes(b64); this.v = new DataView(this.b.buffer); this.p = 0; }
  take(n) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  u32() { const x = this.v.getUint32(this.p); this.p += 4; return x; }
  i32() { const x = this.v.getInt32(this.p); this.p += 4; return x; }
  u64() { const x = this.v.getBigUint64(this.p); this.p += 8; return x; }
  i64() { const x = this.v.getBigInt64(this.p); this.p += 8; return x; }
  opaque() { const n = this.u32(); const s = this.take(n); this.p += (4 - (n % 4)) % 4; return s; }
  address() {
    const t = this.i32();
    if (t === 0) { this.i32(); return strkey(6 << 3, this.take(32)); }
    if (t === 1) return strkey(2 << 3, this.take(32));
    if (t === 2) {
      const id = this.take(8), key = this.take(32), p = new Uint8Array(40);
      p.set(key); p.set(id, 32); return strkey(12 << 3, p);
    }
    if (t === 3) { this.i32(); const p = new Uint8Array(33); p.set(this.take(32), 1); return strkey(1 << 3, p); }
    if (t === 4) return strkey(11 << 3, this.take(32));
    throw new Error(`ScAddress type ${t}`);
  }
  scval() {
    const t = this.i32();
    if (t === 0) return !!this.u32();
    if (t === 1) return null;
    if (t === 3) return this.u32();
    if (t === 4) return this.i32();
    if (t === 5 || t === 7) return this.u64();
    if (t === 6 || t === 8) return this.i64();
    if (t === 9) { const hi = this.u64(); return (hi << 64n) | this.u64(); }
    if (t === 10) { const hi = this.i64(); return (hi << 64n) | this.u64(); }
    if (t === 13 || t === 14 || t === 15) return new TextDecoder().decode(this.opaque());
    if (t === 18) return this.address();
    if (t === 16) { if (!this.u32()) return []; const n = this.u32(); const a = []; for (let i = 0; i < n; i++) a.push(this.scval()); return a; }
    if (t === 17) {
      if (!this.u32()) return {};
      const n = this.u32(), o = {};
      for (let i = 0; i < n; i++) { const k = this.scval(); o[String(k)] = this.scval(); }
      return o;
    }
    throw new Error(`ScVal type ${t}`);
  }
}
const stellarAmount = v => BigInt((v && typeof v === "object") ? (v.amount ?? 0) : (v ?? 0));

async function scanStellar(cur) {
  let lastErr;
  for (const url of STELLAR_RPCS) {
    try {
      const h = await rpc(url, "getHealth", {});
      const oldest = h.oldestLedger, latest = h.latestLedger;
      const start = cur != null ? Math.max(oldest + 1, Number(cur) + 1) : latest - 100;
      if (start > latest) return {rows: [], cursor: cur ?? latest, source: new URL(url).host};
      let params = {startLedger: start, filters: [{type: "contract", contractIds: [STELLAR_SAC]}],
                    pagination: {limit: 500}};
      const rows = [];
      let lastLedger = latest;
      for (let page = 0; page < 4; page++) {
        const res = await rpc(url, "getEvents", params, 30000);
        const evs = res.events || [];
        lastLedger = res.latestLedger ?? lastLedger;
        for (const ev of evs) {
          const topics = ev.topic.map(t => new Xdr(t).scval());
          const kind = topics[0];
          let frm, to;
          if (kind === "transfer" && topics.length >= 3) [frm, to] = [topics[1], topics[2]];
          else if (kind === "mint" && topics.length >= 2) [frm, to] = ["ISSUER", topics.length >= 3 ? topics[topics.length - 2] : topics[1]];
          else if ((kind === "burn" || kind === "clawback") && topics.length >= 2) [frm, to] = [topics[1], "ISSUER"];
          else continue;
          const amt = units(stellarAmount(new Xdr(ev.value).scval()), STELLAR_DEC);
          if (amt < THRESHOLD) continue;
          rows.push({id: `stellar:${ev.id}`, chain: "stellar", ts: parseIso(ev.ledgerClosedAt), amount: amt,
                     from: frm, to, tx: ev.txHash, block: ev.ledger, op: kind});
        }
        if (evs.length < 500) break;
        params = {filters: params.filters, pagination: {limit: 500, cursor: res.cursor || evs[evs.length - 1].id}};
      }
      return {rows, cursor: lastLedger, source: new URL(url).host};
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ------------------------------------------------------------- Native Realio */
async function nativeModules() {
  for (const lcd of NATIVE_LCDS) {
    try {
      const d = await getJ(`${lcd}/cosmos/auth/v1beta1/module_accounts`, {cf: {cacheTtl: 86400, cacheEverything: true}});
      const m = {};
      for (const a of d.accounts || []) if (a.base_account && a.base_account.address) m[a.base_account.address] = a.name;
      if (Object.keys(m).length) return m;
    } catch (e) { /* next */ }
  }
  return {};
}

function ario(s) {
  for (const part of (s || "").split(",")) {
    const m = /^(\d+)ario$/.exec(part.trim());
    if (m) return units(BigInt(m[1]), NATIVE_DEC);
  }
  return 0;
}

async function scanNative(cur, modules) {
  const st = (await getJ(`${NATIVE_RPC}/status`)).result.sync_info;
  const latest = parseInt(st.latest_block_height, 10);
  let start = cur != null ? Number(cur) + 1 : latest - 100;
  const early = parseInt(st.earliest_block_height, 10);
  if (start < early) start = early;
  if (start > latest) return {rows: [], cursor: cur ?? latest, source: "rpc.realio.network"};
  const end = Math.min(latest, start + NATIVE_MAX_BLOCKS - 1);
  const skip = new Set(Object.entries(modules).filter(([, n]) => NATIVE_SKIP_MODULES.has(n)).map(([a]) => a));
  const q = encodeURIComponent(`"tx.height>=${start} AND tx.height<=${end}"`);
  const rows = [];
  let cursor = end;
  for (let page = 1; ; page++) {
    const d = (await getJ(`${NATIVE_RPC}/tx_search?query=${q}&per_page=100&page=${page}&order_by=%22asc%22`)).result;
    const total = parseInt(d.total_count, 10);
    for (const t of d.txs) {
      if ((t.tx_result.code || 0) !== 0) continue;
      const ev = t.tx_result.events || [];
      const acts = {}, ibcOut = {}, ibcIn = {};
      for (const e of ev) {
        const at = Object.fromEntries(e.attributes.map(x => [x.key, x.value]));
        const mi = at.msg_index;
        if (e.type === "message" && at.action) acts[mi] = at.action;
        else if (e.type === "ibc_transfer") ibcOut[mi] = at.receiver;
        else if (e.type === "fungible_token_packet" && at.sender) ibcIn[mi] = at.sender;
      }
      let n = 0;
      for (const e of ev) {
        if (e.type !== "transfer") continue;
        const at = Object.fromEntries(e.attributes.map(x => [x.key, x.value]));
        const mi = at.msg_index;
        if (mi == null) continue;             // tx-level fee transfer
        n += 1;
        const amt = ario(at.amount);
        const frm = at.sender, to = at.recipient;
        if (amt < THRESHOLD || skip.has(frm) || skip.has(to)) continue;
        const act = acts[mi] || "";
        const r = {id: `native:${t.hash}:${mi}:${n}`, chain: "native", ts: null, amount: amt,
                   from: frm, to, tx: t.hash, block: parseInt(t.height, 10), msg: act.split(".").pop()};
        if (act.endsWith("MsgTransfer") && ibcOut[mi]) { r.to = ibcOut[mi]; r.via = "ibc_out"; }
        if (act.endsWith("MsgRecvPacket") && ibcIn[mi]) { r.from = ibcIn[mi]; r.via = "ibc_in"; }
        rows.push(r);
      }
    }
    if (page * 100 >= total || !d.txs.length) break;
    if (page >= 3) {          // busy stretch: finish the last full height next minute
      const lastH = parseInt(d.txs[d.txs.length - 1].height, 10);
      cursor = lastH - 1;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].block > cursor) rows.splice(i, 1);
      break;
    }
  }
  if (rows.length) {
    const hs = [...new Set(rows.map(r => r.block))];
    const exact = {};
    try {
      const r = await fetch(NATIVE_HASURA, {method: "POST", signal: AbortSignal.timeout(15000),
        headers: {"content-type": "application/json", "user-agent": UA},
        body: JSON.stringify({query: "query($h:[bigint!]){block(where:{height:{_in:$h}}){height timestamp}}", variables: {h: hs}})});
      for (const b of (await r.json()).data.block) exact[parseInt(b.height, 10)] = parseIso(b.timestamp);
    } catch (e) { /* header fallback below */ }
    for (const h of hs) {
      if (exact[h]) continue;
      try { exact[h] = parseIso((await getJ(`${NATIVE_RPC}/header?height=${h}`)).result.header.time); } catch (e) { /* estimate */ }
    }
    const lt = parseIso(st.latest_block_time);
    for (const r of rows) {
      if (exact[r.block]) r.ts = exact[r.block];
      else { r.ts = lt - Math.round((latest - r.block) * 5); r.time_est = true; }
    }
  }
  return {rows, cursor, behind: latest - cursor, source: "rpc.realio.network"};
}

/* ------------------------------------------------------------- labels + kinds */
async function buildLabels(modules) {
  const lab = {};
  for (const [c, m] of Object.entries(STATIC_LABELS)) {
    lab[c] = {};
    for (const [k, v] of Object.entries(m)) lab[c][EVM[c] ? k.toLowerCase() : k] = v;
  }
  try {
    const h = await getJ(`${SITE}/holders.json`, {cf: {cacheTtl: 3600, cacheEverything: true}});
    for (const ex of h.bsc_exchanges || []) {
      const kind = /dex/i.test(ex.entity) ? "dex" : "exchange";
      for (const a of ex.addresses || []) (lab.bnb ||= {})[a.toLowerCase()] = [kind === "dex" ? "DEX pool" : ex.entity, kind];
    }
    for (const ex of h.eth_holders || []) {
      const t = (ex.type || "").toLowerCase();
      const kind = t.includes("dex") ? "dex" : t.includes("bridge") ? "bridge" : "exchange";
      const name = {dex: "DEX pool", bridge: "Base bridge (escrow)"}[kind] || ex.holder;
      for (const a of ex.addresses || []) (lab.eth ||= {})[a.toLowerCase()] = [name, kind];
    }
  } catch (e) { /* static labels only */ }
  const nice = {bridge: ["Bridge module", "bridge"], transfer: ["IBC module", "ibc"],
                erc20: ["ERC-20 module", "module"], evm: ["EVM module", "module"]};
  for (const [addr, name] of Object.entries(modules)) (lab.native ||= {})[addr] = nice[name] || [`${name} module`, "module"];
  return lab;
}

const ibcChain = a => { const p = (a || "").split("1")[0]; return IBC_PREFIX[p] || p || "IBC"; };

function classify(r, labels) {
  const c = r.chain, L = labels[c] || {};
  const key = a => (EVM[c] ? (a || "").toLowerCase() : a);
  let fl = L[key(r.from)], tl = L[key(r.to)], kind = "wallet";
  if (EVM[c] && r.from === ZERO_EVM) { fl = ["Bridge mint", "bridge"]; kind = "bridge_in"; }
  else if (EVM[c] && r.to === ZERO_EVM) { tl = ["Bridge burn", "bridge"]; kind = "bridge_out"; }
  else if (c === "eth" && key(r.to) === BASE_L1_BRIDGE) kind = "bridge_out";
  else if (c === "eth" && key(r.from) === BASE_L1_BRIDGE) kind = "bridge_in";
  else if (c === "solana" && r.from === "MINT") { fl = ["Bridge mint", "bridge"]; kind = "bridge_in"; }
  else if (c === "solana" && r.to === "BURN") { tl = ["Bridge burn", "bridge"]; kind = "bridge_out"; }
  else if (c === "stellar" && r.from === "ISSUER") { fl = ["RIO issuer (mint)", "issuer"]; kind = "mint"; }
  else if (c === "stellar" && r.to === "ISSUER") { tl = ["RIO issuer (burn)", "issuer"]; kind = "burn"; }
  else if (c === "native" && r.msg === "MsgBridgeOut") { tl = ["Bridge burn", "bridge"]; kind = "bridge_out"; }
  else if (c === "native" && r.msg === "MsgBridgeIn") { fl = ["Bridge mint", "bridge"]; kind = "bridge_in"; }
  else if (r.via === "ibc_out") { tl = [`${ibcChain(r.to)} (via IBC)`, "ibc"]; kind = "ibc_out"; }
  else if (r.via === "ibc_in") { fl = [`${ibcChain(r.from)} (via IBC)`, "ibc"]; kind = "ibc_in"; }
  else {
    const fk = fl && fl[1], tk = tl && tl[1];
    if (fk === "exchange" && tk === "exchange" && fl[0] === tl[0]) kind = "exchange";
    else if (tk === "exchange") kind = "deposit";
    else if (fk === "exchange") kind = "withdrawal";
    else if (fk === "dex" || tk === "dex") kind = "dex";
  }
  r.kind = kind;
  r.from_label = fl ? fl[0] : null;
  r.to_label = tl ? tl[0] : null;
  return r;
}

/* ------------------------------------------------------------- run */
const CHAINS = ["bnb", "eth", "base", "solana", "algorand", "stellar", "native"];

async function runOnce(env) {
  const t0 = now();
  const prev = {};
  for (const r of (await env.DB.prepare("SELECT chain, cursor FROM cursors").all()).results) prev[r.chain] = r.cursor;
  // First run: start each chain where the daily file left off
  if (CHAINS.some(c => prev[c] == null)) {
    try {
      const d = await getJ(`${SITE}/large-transfers.json`);
      for (const c of CHAINS) if (prev[c] == null && d.chains?.[c]?.cursor != null) prev[c] = String(d.chains[c].cursor);
    } catch (e) { /* chains start from "now" */ }
  }
  const modules = await nativeModules();
  const labels = await buildLabels(modules);
  const scan = {
    bnb: c => scanEvm("bnb", c, {}, env), eth: c => scanEvm("eth", c, {}, env), base: c => scanEvm("base", c, {}, env),
    solana: c => scanSolana(c), algorand: c => scanAlgorand(c), stellar: c => scanStellar(c),
    native: c => scanNative(c, modules),
  };
  const res = await Promise.allSettled(CHAINS.map(c => scan[c](prev[c] ?? null)));
  const stmts = [];
  const upsert = env.DB.prepare(
    "INSERT INTO cursors (chain, cursor, updated, status, error, source, behind) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(chain) DO UPDATE SET cursor = excluded.cursor, updated = excluded.updated, status = excluded.status, " +
    "error = excluded.error, source = excluded.source, behind = excluded.behind");
  const fail = env.DB.prepare(
    "INSERT INTO cursors (chain, cursor, updated, status, error) VALUES (?, ?, ?, 'error', ?) " +
    "ON CONFLICT(chain) DO UPDATE SET status = 'error', error = excluded.error, updated = excluded.updated");
  const ins = env.DB.prepare("INSERT OR IGNORE INTO transfers (id, chain, ts, row, seen) VALUES (?, ?, ?, ?, ?)");
  let found = 0;
  CHAINS.forEach((c, i) => {
    const r = res[i];
    if (r.status === "fulfilled") {
      const v = r.value;
      stmts.push(upsert.bind(c, v.cursor == null ? null : String(v.cursor), t0, v.gap ? "gap" : "ok",
                             v.note || null, v.source || null, v.behind ?? null));
      for (const row of v.rows) {
        if (!row.ts || row.ts < t0 - KEEP_S) continue;
        classify(row, labels);
        delete row.msg; delete row.via;
        stmts.push(ins.bind(row.id, c, row.ts, JSON.stringify(row), t0));
        found++;
      }
    } else {
      stmts.push(fail.bind(c, prev[c] ?? null, t0, String(r.reason && r.reason.message || r.reason).slice(0, 200)));
    }
  });
  stmts.push(env.DB.prepare("DELETE FROM transfers WHERE ts < ?").bind(t0 - KEEP_S));
  await env.DB.batch(stmts);
  return {found, chains: CHAINS.map((c, i) => [c, res[i].status])};
}

async function serve(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/live-transfers") return new Response("Not found", {status: 404});
  const cache = caches.default;
  const key = new Request(url.origin + url.pathname);
  const hit = await cache.match(key);
  if (hit) return hit;
  const t = now();
  const [tr, cu] = await env.DB.batch([
    env.DB.prepare("SELECT row FROM transfers WHERE ts >= ? ORDER BY ts DESC").bind(t - KEEP_S),
    env.DB.prepare("SELECT chain, updated, status, error, source, behind FROM cursors"),
  ]);
  const chains = {};
  for (const r of cu.results) {
    chains[r.chain] = {checked: new Date(r.updated * 1000).toISOString().slice(0, 19) + "Z", status: r.status,
                       source: r.source, behind: r.behind, error: r.error || undefined};
  }
  const checked = cu.results.filter(r => r.status !== "error").map(r => r.updated);
  const body = {
    as_of: new Date(t * 1000).toISOString().slice(0, 19) + "Z",
    checked: checked.length ? new Date(Math.min(...checked) * 1000).toISOString().slice(0, 19) + "Z" : null,
    threshold_rio: THRESHOLD, keep_hours: KEEP_S / 3600,
    note: "Transfers found since the daily large-transfers.json run, checked every minute. Bridge legs are paired by the daily job.",
    chains, transfers: tr.results.map(r => JSON.parse(r.row)),
  };
  const res = new Response(JSON.stringify(body), {headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=30",
    "access-control-allow-origin": "*"}});
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  fetch: serve,
  async scheduled(event, env, ctx) { ctx.waitUntil(runOnce(env)); },
  _test: {scanEvm, scanSolana, scanAlgorand, scanStellar, scanNative, nativeModules, buildLabels, classify},
};
