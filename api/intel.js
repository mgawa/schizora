// SCHIZORA wallet intelligence: creator history and linked holders.
// GET /api/intel?t=<token>&c=<creator>&o=<owner>&h=<holder1,holder2,...>
// Uses the NodeReal MegaNode API (free tier). Set NODEREAL_KEY in Vercel.
// Results are cached for 6 hours in the Upstash Redis database used by /api/stats.

const RURL = process.env.STATS_REDIS_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const RTOK = process.env.STATS_REDIS_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const KEY = process.env.NODEREAL_KEY || '';
const NR = 'https://bsc-mainnet.nodereal.io/v1/' + KEY;
const RPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io'];
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';
const TTL = 6 * 3600;

async function redis(cmds) {
  if (!RURL || !RTOK) return null;
  try {
    const r = await fetch(RURL + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
    if (!r.ok) return null;
    return (await r.json()).map(x => x.result);
  } catch (e) { return null; }
}

let calls = 0;
async function nr(params) {
  calls++;
  const r = await fetch(NR, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(9000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nr_getAssetTransfers', params: [params] }) });
  const j = await r.json();
  if (j.error) throw new Error('NodeReal: ' + (j.error.message || JSON.stringify(j.error)).slice(0, 140));
  return (j.result && j.result.transfers) || [];
}
async function rpc(method, params) {
  for (const u of RPCS) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json(); if (j.result !== undefined) return j.result;
    } catch (e) {}
  }
  return null;
}
const ts = t => Number(t.blockTimeStamp || t.blockTimestamp || 0);
const lc = s => String(s || '').toLowerCase();
const amount = t => { try { const d = Number(t.decimal || 18); return Number(BigInt(t.value || '0x0')) / 10 ** d; } catch (e) { return 0; } };

// Run tasks with a small concurrency limit so the free tier is not flooded.
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: String(e.message || e) }; } } }));
  return out;
}

async function creatorHistory(c) {
  const [minted, sent, firstIn] = await Promise.all([
    nr({ category: ['20'], fromAddress: ZERO, toAddress: c, order: 'desc', maxCount: '0x3E8' }),
    nr({ category: ['20'], fromAddress: c, order: 'desc', maxCount: '0x3E8' }),
    nr({ category: ['external'], toAddress: c, order: 'asc', maxCount: '0x1' })
  ]);
  const tokens = new Map(), lpAdds = new Map();
  for (const t of minted) {
    const a = lc(t.contractAddress); if (!ADDR.test(a)) continue;
    if (/cake-lp|-lp$/i.test(t.asset || '')) { if (!lpAdds.has(a)) lpAdds.set(a, ts(t)); continue; }
    const prev = tokens.get(a);
    if (!prev || ts(t) < prev.t) tokens.set(a, { a, sym: String(t.asset || '').slice(0, 16), t: ts(t) });
  }
  // Removing liquidity sends the pool tokens from the wallet back to the pool contract itself.
  const removals = new Map();
  for (const t of sent) {
    const a = lc(t.contractAddress);
    if (a && lc(t.to) === a && /cake-lp|-lp$/i.test(t.asset || '')) { const r = removals.get(a) || { pair: a, t: ts(t), n: 0, hash: t.hash }; r.n++; if (ts(t) > r.t) { r.t = ts(t); r.hash = t.hash; } removals.set(a, r); }
  }
  const rem = [...removals.values()].sort((x, y) => y.t - x.t).slice(0, 25);
  await pool(rem, 4, async r => {
    const [t0, t1] = await Promise.all([rpc('eth_call', [{ to: r.pair, data: '0x0dfe1681' }, 'latest']), rpc('eth_call', [{ to: r.pair, data: '0xd21220a7' }, 'latest'])]);
    r.tokens = [t0, t1].filter(Boolean).map(x => '0x' + String(x).slice(-40).toLowerCase());
  });
  const f = firstIn[0];
  return {
    address: c,
    firstSeen: f ? ts(f) : null,
    fundedBy: f ? lc(f.from) : null,
    tokens: [...tokens.values()].sort((x, y) => y.t - x.t).slice(0, 60),
    tokenCount: tokens.size,
    lpAdds: lpAdds.size,
    removals: rem,
    truncated: minted.length >= 1000 || sent.length >= 1000
  };
}

async function holderLinks(token, holders, insiders) {
  const rows = await pool(holders, 4, async h => {
    const [bnb, tok] = await Promise.all([
      nr({ category: ['external'], toAddress: h, order: 'asc', maxCount: '0x1' }),
      nr({ category: ['20'], contractAddresses: [token], toAddress: h, order: 'asc', maxCount: '0x1' })
    ]);
    return { a: h, funder: bnb[0] ? lc(bnb[0].from) : null, fundT: bnb[0] ? ts(bnb[0]) : null, gotFrom: tok[0] ? lc(tok[0].from) : null, gotT: tok[0] ? ts(tok[0]) : null };
  });
  // A funder with a very long transaction history is an exchange or a busy service wallet, not a person.
  const funders = [...new Set(rows.map(r => r && r.funder).filter(Boolean))];
  const busy = {};
  await pool(funders, 4, async f => { const n = await rpc('eth_getTransactionCount', [f, 'latest']); busy[f] = n ? parseInt(n, 16) : 0; });
  for (const r of rows) if (r && r.funder) { r.funderTx = busy[r.funder] || 0; r.exchange = r.funderTx > 5000; r.insiderFunded = insiders.includes(r.funder); r.fromInsider = insiders.includes(r.gotFrom || ''); }
  return rows;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=600');
  if (!KEY) return res.status(503).json({ error: 'Wallet history is not configured yet.' });
  const q = req.query || {};
  const t = lc(q.t), c = lc(q.c), o = lc(q.o);
  const h = String(q.h || '').split(',').map(lc).filter(a => ADDR.test(a)).slice(0, 8);
  if (!ADDR.test(t)) return res.status(400).json({ error: 'Bad token address' });
  const ck = 'szr:intel:' + t;
  if (!q.fresh) { const [hit] = (await redis([['GET', ck]])) || []; if (hit) { try { return res.status(200).json({ ...JSON.parse(hit), cached: true }); } catch (e) {} } }
  try {
    const insiders = [c, o].filter(a => ADDR.test(a) && a !== ZERO);
    const [creator, holders] = await Promise.all([
      ADDR.test(c) && c !== ZERO ? creatorHistory(c) : null,
      h.length ? holderLinks(t, h, insiders) : []
    ]);
    const out = { token: t, creator, holders, at: Math.floor(Date.now() / 1000), calls };
    await redis([['SET', ck, JSON.stringify(out), 'EX', TTL]]);
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: 'Wallet history could not be read right now.', detail: String(e.message || e).slice(0, 160) });
  }
};
