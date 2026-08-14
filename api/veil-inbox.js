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
const MAX_PENDING_PER_WALLET = 50;
const MAX_PROOF_AGE_MS = 5 * 60 * 1000;
const MESSAGE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SEND_LIMIT_PER_MINUTE = 12;

function isWallet(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
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

function inboxKey(wallet) {
  return `veil:pending:${wallet.toLowerCase()}`;
}

function rateKey(wallet) {
  const minute = Math.floor(Date.now() / 60000);
  return `veil:pending:rate:${wallet.toLowerCase()}:${minute}`;
}

function sendProof({ sender, recipient, timestamp, message }) {
  const hash = crypto.createHash("sha256").update(message, "utf8").digest("hex");
  return [
    "SCHIZORA VEIL Pending Message",
    "",
    "This signature authorizes storing one pending VEIL message.",
    "It does not authorize a token transfer.",
    "",
    `Sender: ${sender.toLowerCase()}`,
    `Recipient: ${recipient.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
    `Message SHA256: ${hash}`,
  ].join("\n");
}

function claimProof({ wallet, timestamp }) {
  return [
    "SCHIZORA VEIL Pending Inbox Claim",
    "",
    "This signature proves wallet ownership and unlocks pending VEIL messages.",
    "It does not authorize a token transfer.",
    "",
    `Wallet: ${wallet.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
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

async function readInbox(wallet) {
  const raw = await redis.get(inboxKey(wallet));
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function writeInbox(wallet, items) {
  if (!items.length) {
    await redis.del(inboxKey(wallet));
    return;
  }
  await redis.set(inboxKey(wallet), JSON.stringify(items), { ex: MESSAGE_TTL_SECONDS });
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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (!redis || !MASTER_KEY_B64) {
    return res.status(503).json({ error: "VEIL pending inbox is not configured." });
  }

  if (req.method === "GET") {
    const { action, wallet } = req.query || {};

    if (action === "health") {
      try {
        decodeMasterKey();
        return res.status(200).json({
          ok: true,
          redisConfigured: true,
          inboxKeyConfigured: true,
        });
      } catch {
        return res.status(503).json({
          ok: false,
          redisConfigured: true,
          inboxKeyConfigured: false,
        });
      }
    }

    if (action === "has-pending") {
      if (!isWallet(wallet)) {
        return res.status(400).json({ error: "Invalid BSC wallet address." });
      }
      const inbox = await readInbox(wallet);
      return res.status(200).json({ hasPending: inbox.length > 0 });
    }

    return res.status(404).json({ error: "Not found." });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = req.body || {};

  if (body.action === "send") {
    const allowed = new Set([
      "action", "sender", "recipient", "timestamp", "signature", "message"
    ]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ error: "Unexpected message metadata." });
    }

    const { sender, recipient, timestamp, signature, message } = body;

    if (!isWallet(sender) || !isWallet(recipient)) {
      return res.status(400).json({ error: "Invalid BSC wallet address." });
    }
    if (sender.toLowerCase() === recipient.toLowerCase()) {
      return res.status(400).json({ error: "Choose another recipient wallet." });
    }
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > MAX_MESSAGE_LENGTH
    ) {
      return res.status(400).json({ error: "Invalid message." });
    }
    if (!proofFresh(timestamp)) {
      return res.status(401).json({ error: "Expired wallet proof." });
    }
    if (!(await rateAllowed(sender))) {
      return res.status(429).json({ error: "Pending-message rate limit reached." });
    }

    let verified = false;
    try {
      verified = await verifyMessage({
        address: sender,
        message: sendProof({
          sender,
          recipient,
          timestamp: Number(timestamp),
          message,
        }),
        signature,
      });
    } catch {}

    if (!verified) {
      return res.status(401).json({ error: "Sender wallet ownership proof failed." });
    }

    const inbox = await readInbox(recipient);
    if (inbox.length >= MAX_PENDING_PER_WALLET) {
      return res.status(429).json({ error: "Recipient pending inbox is full." });
    }

    const now = Date.now();
    inbox.push({
      id: crypto.randomUUID(),
      createdAt: now,
      encrypted: encryptPayload({
        sender: sender.toLowerCase(),
        recipient: recipient.toLowerCase(),
        message,
        createdAt: now,
      }),
    });

    await writeInbox(recipient, inbox);
    return res.status(201).json({ ok: true });
  }

  if (body.action === "claim") {
    const allowed = new Set(["action", "wallet", "timestamp", "signature"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ error: "Unexpected claim metadata." });
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
        message: claimProof({ wallet, timestamp: Number(timestamp) }),
        signature,
      });
    } catch {}

    if (!verified) {
      return res.status(401).json({ error: "Recipient wallet ownership proof failed." });
    }

    const inbox = await readInbox(wallet);
    const messages = [];

    for (const item of inbox) {
      try {
        const payload = decryptPayload(item.encrypted);
        if (payload.recipient?.toLowerCase() !== wallet.toLowerCase()) continue;
        messages.push({
          id: item.id,
          sender: payload.sender,
          message: payload.message,
          createdAt: payload.createdAt,
        });
      } catch {}
    }

    await writeInbox(wallet, []);

    return res.status(200).json({ ok: true, messages });
  }

  return res.status(400).json({ error: "Unknown action." });
}
