import { Redis } from "@upstash/redis";
import { verifyMessage } from "viem";
import crypto from "node:crypto";

const REDIS_URL =
  process.env.VEIL_REDIS_KV_REST_API_URL ||
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL;

const REDIS_TOKEN =
  process.env.VEIL_REDIS_KV_REST_API_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN;

const MASTER_KEY_B64 = process.env.VEIL_INBOX_MASTER_KEY || "";

const redis = REDIS_URL && REDIS_TOKEN
  ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN })
  : null;

const MAX_MESSAGE_LENGTH = 2000;
const MAX_MESSAGES_PER_THREAD = 200;
const MAX_PROOF_AGE_MS = 5 * 60 * 1000;
const THREAD_TTL_SECONDS = 180 * 24 * 60 * 60;
const SEND_LIMIT_PER_MINUTE = 30;
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;

function isWallet(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function normalizeWallet(value) {
  return String(value || "").toLowerCase();
}

function decodeMasterKey() {
  const pad = "=".repeat((4 - (MASTER_KEY_B64.length % 4)) % 4);
  const normalized = (MASTER_KEY_B64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const key = Buffer.from(normalized, "base64");
  if (key.length !== 32) {
    throw new Error("VEIL_INBOX_MASTER_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

function threadId(a, b) {
  return [normalizeWallet(a), normalizeWallet(b)].sort().join(":");
}

function threadKey(a, b) {
  return `veil:thread:${threadId(a, b)}`;
}

function peersKey(wallet) {
  return `veil:peers:${normalizeWallet(wallet)}`;
}

function rateKey(wallet) {
  const minute = Math.floor(Date.now() / 60000);
  return `veil:thread:rate:${normalizeWallet(wallet)}:${minute}`;
}

function sessionProof({ wallet, timestamp }) {
  return [
    "SCHIZORA VEIL Session",
    "",
    "This signature authorizes this browser session for VEIL messaging.",
    "It does not authorize a token transfer.",
    "",
    `Wallet: ${normalizeWallet(wallet)}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}

function issueSessionToken(wallet) {
  const now = Date.now();
  const payload = {
    v: 1,
    wallet: normalizeWallet(wallet),
    iat: now,
    exp: now + SESSION_TTL_MS,
    nonce: crypto.randomBytes(12).toString("hex"),
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", decodeMasterKey())
    .update(encoded)
    .digest("base64url");

  return {
    token: `${encoded}.${signature}`,
    expiresAt: payload.exp,
  };
}

function verifySessionToken(token, wallet) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [encoded, signature] = parts;
  const expected = crypto
    .createHmac("sha256", decodeMasterKey())
    .update(encoded)
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  return (
    payload?.v === 1 &&
    payload.wallet === normalizeWallet(wallet) &&
    Number(payload.exp) > Date.now()
  );
}

function encryptPayload(value) {
  const key = decodeMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    data: ciphertext.toString("base64url"),
  };
}

function decryptPayload(envelope) {
  const key = decodeMasterKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function readThread(a, b) {
  const raw = await redis.get(threadKey(a, b));
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
  }
  return [];
}

async function writeThread(a, b, items) {
  await redis.set(
    threadKey(a, b),
    JSON.stringify(items.slice(-MAX_MESSAGES_PER_THREAD)),
    { ex: THREAD_TTL_SECONDS }
  );
}

async function addPeer(wallet, peer) {
  await redis.sadd(peersKey(wallet), normalizeWallet(peer));
  await redis.expire(peersKey(wallet), THREAD_TTL_SECONDS);
}

async function getPeers(wallet) {
  const peers = await redis.smembers(peersKey(wallet));
  return Array.isArray(peers) ? peers.filter(isWallet) : [];
}

async function rateAllowed(wallet) {
  const key = rateKey(wallet);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 70);
  return count <= SEND_LIMIT_PER_MINUTE;
}

function proofFresh(timestamp) {
  const value = Number(timestamp);
  return Number.isFinite(value) && Math.abs(Date.now() - value) <= MAX_PROOF_AGE_MS;
}

function decryptThreadFor(wallet, peer, items) {
  const me = normalizeWallet(wallet);
  const them = normalizeWallet(peer);
  const output = [];

  for (const item of items) {
    try {
      const payload = decryptPayload(item.encrypted);
      const sender = normalizeWallet(payload.sender);
      const recipient = normalizeWallet(payload.recipient);

      const belongs =
        (sender === me && recipient === them) ||
        (sender === them && recipient === me);

      if (!belongs) continue;

      output.push({
        id: item.id,
        sender,
        recipient,
        message: payload.message,
        createdAt: payload.createdAt,
        transport: "veil-pending",
      });
    } catch {}
  }

  return output.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (!redis || !MASTER_KEY_B64) {
    return res.status(503).json({ error: "VEIL conversation service is not configured." });
  }

  if (req.method === "GET") {
    if (req.query?.action === "health") {
      try {
        decodeMasterKey();
        return res.status(200).json({
          ok: true,
          redisConfigured: true,
          inboxKeyConfigured: true,
          sessionAuth: true,
          conversations: true,
        });
      } catch {
        return res.status(503).json({
          ok: false,
          redisConfigured: true,
          inboxKeyConfigured: false,
          sessionAuth: false,
          conversations: false,
        });
      }
    }

    return res.status(404).json({ error: "Not found." });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = req.body || {};

  if (body.action === "session") {
    const allowed = new Set(["action", "wallet", "timestamp", "signature"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ error: "Unexpected session metadata." });
    }

    const { wallet, timestamp, signature } = body;

    if (!isWallet(wallet)) {
      return res.status(400).json({ error: "Invalid BSC wallet address." });
    }
    if (!proofFresh(timestamp)) {
      return res.status(401).json({ error: "Expired wallet proof." });
    }

    let verified = false;
    try {
      verified = await verifyMessage({
        address: wallet,
        message: sessionProof({ wallet, timestamp: Number(timestamp) }),
        signature,
      });
    } catch {}

    if (!verified) {
      return res.status(401).json({ error: "Wallet ownership proof failed." });
    }

    const session = issueSessionToken(wallet);
    return res.status(201).json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
    });
  }

  const wallet = body.wallet || body.sender;
  const sessionToken = body.sessionToken;

  if (!isWallet(wallet) || !verifySessionToken(sessionToken, wallet)) {
    return res.status(401).json({ error: "VEIL session expired." });
  }

  if (body.action === "send") {
    const allowed = new Set([
      "action", "sender", "recipient", "sessionToken", "message"
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ error: "Unexpected message metadata." });
    }

    const { sender, recipient, message } = body;

    if (!isWallet(sender) || !isWallet(recipient)) {
      return res.status(400).json({ error: "Invalid BSC wallet address." });
    }
    if (normalizeWallet(sender) === normalizeWallet(recipient)) {
      return res.status(400).json({ error: "Choose another recipient wallet." });
    }
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > MAX_MESSAGE_LENGTH
    ) {
      return res.status(400).json({ error: "Invalid message." });
    }
    if (!(await rateAllowed(sender))) {
      return res.status(429).json({ error: "Message rate limit reached." });
    }

    const items = await readThread(sender, recipient);
    const now = Date.now();

    items.push({
      id: crypto.randomUUID(),
      createdAt: now,
      encrypted: encryptPayload({
        sender: normalizeWallet(sender),
        recipient: normalizeWallet(recipient),
        message: message.trim(),
        createdAt: now,
      }),
    });

    await writeThread(sender, recipient, items);
    await Promise.all([
      addPeer(sender, recipient),
      addPeer(recipient, sender),
    ]);

    return res.status(201).json({ ok: true, createdAt: now });
  }

  if (body.action === "history") {
    const allowed = new Set([
      "action", "wallet", "peer", "sessionToken"
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ error: "Unexpected history metadata." });
    }

    const { peer } = body;
    if (!isWallet(peer) || normalizeWallet(peer) === normalizeWallet(wallet)) {
      return res.status(400).json({ error: "Invalid peer wallet." });
    }

    const items = await readThread(wallet, peer);
    return res.status(200).json({
      ok: true,
      messages: decryptThreadFor(wallet, peer, items),
    });
  }

  if (body.action === "list") {
    const allowed = new Set(["action", "wallet", "sessionToken"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ error: "Unexpected conversation metadata." });
    }

    const peers = await getPeers(wallet);
    const conversations = [];

    for (const peer of peers.slice(0, 100)) {
      const items = await readThread(wallet, peer);
      const messages = decryptThreadFor(wallet, peer, items);
      const last = messages[messages.length - 1];

      conversations.push({
        peer: normalizeWallet(peer),
        lastMessage: last?.message || "",
        lastAt: last?.createdAt || 0,
      });
    }

    conversations.sort((a, b) => Number(b.lastAt) - Number(a.lastAt));
    return res.status(200).json({ ok: true, conversations });
  }

  return res.status(400).json({ error: "Unknown action." });
}
