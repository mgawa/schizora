import webpush from "web-push";
import { Redis } from "@upstash/redis";
import { verifyMessage } from "viem";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

const REDIS_URL =
  process.env.VEIL_REDIS_KV_REST_API_URL ||
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL;

const REDIS_TOKEN =
  process.env.VEIL_REDIS_KV_REST_API_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = REDIS_URL && REDIS_TOKEN
  ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN })
  : null;

const MAX_DEVICES_PER_WALLET = 5;
const MAX_PROOF_AGE_MS = 5 * 60 * 1000;
const NOTIFY_LIMIT_PER_MINUTE = 8;

function isWallet(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function subscriptionKey(wallet) {
  return `veil:push:${wallet.toLowerCase()}`;
}

function rateKey(wallet) {
  const minute = Math.floor(Date.now() / 60000);
  return `veil:push:rate:${wallet.toLowerCase()}:${minute}`;
}

function pushConfigured() {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
}

function redisConfigured() {
  return Boolean(redis);
}

function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function expectedProof(wallet, timestamp) {
  return [
    "SCHIZORA VEIL Push Registration",
    "",
    "This signature registers this browser for generic VEIL message alerts.",
    "It does not authorize a token transfer.",
    "",
    `Wallet: ${wallet.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");
}

async function readSubscriptions(wallet) {
  const raw = await redis.get(subscriptionKey(wallet));
  if (!raw) return [];

  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return [raw];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function writeSubscriptions(wallet, subscriptions) {
  await redis.set(subscriptionKey(wallet), JSON.stringify(subscriptions));
}

async function verifyWalletProof(wallet, timestamp, signature) {
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) return false;
  if (Math.abs(Date.now() - numericTimestamp) > MAX_PROOF_AGE_MS) return false;
  if (typeof signature !== "string" || !signature.startsWith("0x")) return false;

  return verifyMessage({
    address: wallet,
    message: expectedProof(wallet, numericTimestamp),
    signature,
  });
}

async function rateAllowed(wallet) {
  const key = rateKey(wallet);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 70);
  return count <= NOTIFY_LIMIT_PER_MINUTE;
}

export default async function handler(req, res) {
  setNoStore(res);

  if (req.method === "GET") {
    if (req.query.action === "health") {
      return res.status(200).json({
        ok: pushConfigured() && redisConfigured(),
        pushConfigured: pushConfigured(),
        redisConfigured: redisConfigured(),
      });
    }

    if (req.query.action === "vapid") {
      if (!pushConfigured()) {
        return res.status(503).json({ error: "Push not configured." });
      }
      return res.status(200).json({ publicKey: VAPID_PUBLIC_KEY });
    }

    return res.status(404).json({ error: "Not found." });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!pushConfigured() || !redisConfigured()) {
    return res.status(503).json({ error: "VEIL push service is not configured." });
  }

  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );

  const body = req.body || {};
  const { action, wallet } = body;

  if (!isWallet(wallet)) {
    return res.status(400).json({ error: "Invalid wallet." });
  }

  if (action === "subscribe") {
    const allowedKeys = new Set([
      "action", "wallet", "timestamp", "signature", "subscription"
    ]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      return res.status(400).json({ error: "Unexpected subscription data." });
    }

    const { timestamp, signature, subscription } = body;
    if (
      !subscription?.endpoint ||
      !subscription?.keys?.p256dh ||
      !subscription?.keys?.auth
    ) {
      return res.status(400).json({ error: "Invalid push subscription." });
    }

    let verified = false;
    try {
      verified = await verifyWalletProof(wallet, timestamp, signature);
    } catch {}
    if (!verified) {
      return res.status(401).json({ error: "Wallet ownership proof failed." });
    }

    const subscriptions = await readSubscriptions(wallet);
    const next = subscriptions.filter(
      (item) => item?.endpoint && item.endpoint !== subscription.endpoint
    );
    next.unshift(subscription);

    await writeSubscriptions(wallet, next.slice(0, MAX_DEVICES_PER_WALLET));
    return res.status(201).json({ ok: true });
  }

  if (action === "notify") {
    // Enforce the privacy boundary in the API itself.
    // This request is intentionally not allowed to contain sender/message data.
    const allowedKeys = new Set(["action", "wallet"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      return res.status(400).json({ error: "Notification metadata rejected." });
    }

    if (!(await rateAllowed(wallet))) {
      return res.status(429).json({ error: "Notification rate limit reached." });
    }

    const subscriptions = await readSubscriptions(wallet);
    if (!subscriptions.length) {
      return res.status(404).json({ error: "Recipient has no push subscription." });
    }

    const payload = JSON.stringify({
      type: "veil-message",
      url: "/#veil",
    });

    const survivors = [];
    let delivered = 0;

    for (const subscription of subscriptions) {
      try {
        await webpush.sendNotification(subscription, payload, {
          TTL: 300,
          urgency: "high",
        });
        survivors.push(subscription);
        delivered += 1;
      } catch (error) {
        // 404/410 means the browser subscription no longer exists.
        if (error?.statusCode !== 404 && error?.statusCode !== 410) {
          survivors.push(subscription);
        }
      }
    }

    if (survivors.length !== subscriptions.length) {
      await writeSubscriptions(wallet, survivors);
    }

    if (!delivered) {
      return res.status(502).json({ error: "No push endpoint accepted the alert." });
    }

    return res.status(202).json({ ok: true, delivered });
  }

  return res.status(400).json({ error: "Unknown action." });
}
