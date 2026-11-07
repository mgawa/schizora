// SCHIZORA public counters: visits, connected wallets, analyzed tokens.
// Uses the Upstash Redis database already linked to this Vercel project.
// Stores no personal data: wallet and token addresses are kept only as SHA-256
// fingerprints inside a HyperLogLog counter, and IP fingerprints expire after 60 seconds.

const crypto = require('crypto');

const URL = process.env.VEIL_REDIS_KV_REST_API_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.VEIL_REDIS_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const K = { visits: 'szr:stats:visits', wallets: 'szr:stats:wallets', analyses: 'szr:stats:analyses', tokens: 'szr:stats:tokens', since: 'szr:stats:since' };
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

async function redis(cmds) {
  const r = await fetch(URL + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('Redis HTTP ' + r.status + ' ' + (await r.text()).slice(0, 80));
  return (await r.json()).map(x => x.result);
}

async function counts() {
  const [v, w, a, t, since] = await redis([['GET', K.visits], ['PFCOUNT', K.wallets], ['GET', K.analyses], ['PFCOUNT', K.tokens], ['GET', K.since]]);
  return { visits: Number(v || 0), wallets: Number(w || 0), analyses: Number(a || 0), tokens: Number(t || 0), since: since || null };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL || !TOKEN) return res.status(503).json({ error: 'Counters are not configured.' });
  try {
    if (req.method === 'GET') return res.status(200).json(await counts());
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const e = String(body.e || '');
    if (!['visit', 'wallet', 'analysis'].includes(e)) return res.status(400).json({ error: 'Unknown event' });

    // Light anti-spam: one event of each kind per IP per minute.
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    const gate = 'szr:stats:gate:' + sha(ip + '|' + e + '|' + (body.a || body.t || ''));
    const [ok] = await redis([['SET', gate, '1', 'NX', 'EX', '60']]);
    if (ok === 'OK') {
      const cmds = [['SETNX', K.since, new Date().toISOString().slice(0, 10)]];
      if (e === 'visit') cmds.push(['INCR', K.visits]);
      if (e === 'wallet' && ADDR.test(body.a || '')) cmds.push(['PFADD', K.wallets, sha(String(body.a).toLowerCase())]);
      if (e === 'analysis' && ADDR.test(body.t || '')) cmds.push(['INCR', K.analyses], ['PFADD', K.tokens, sha(String(body.t).toLowerCase())]);
      await redis(cmds);
    }
    return res.status(200).json(await counts());
  } catch (err) {
    return res.status(500).json({ error: 'Counters are unavailable right now.', detail: String(err && err.message || err).slice(0, 120), host: (URL || '').replace(/^https?:\/\//, '').split('.')[0] });
  }
};
