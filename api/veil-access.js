import { Redis } from "@upstash/redis";
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
} from "viem";
import { bsc } from "viem/chains";
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
const TREASURY_WALLET = (process.env.VEIL_TREASURY_WALLET || "").toLowerCase();
const MONTHLY_FEE_SZR = process.env.VEIL_MONTHLY_FEE_SZR || "7000";
const BSC_RPC_URL =
  process.env.VEIL_BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org";

const SZR_TOKEN = "0x19435589903409Ad15B3b4c4c3ECA6cb2d66c064";
const SZR_DECIMALS = 18;
const HOLD_REQUIRED_SZR = "1000";
const ACCESS_DAYS = 30;
const ACCESS_MS = ACCESS_DAYS * 24 * 60 * 60 * 1000;

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

const redis = REDIS_URL && REDIS_TOKEN
  ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN })
  : null;

const publicClient = createPublicClient({
  chain: bsc,
  transport: http(BSC_RPC_URL),
});

function isWallet(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isTxHash(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
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
    payload.wallet === wallet.toLowerCase() &&
    Number(payload.exp) > Date.now()
  );
}

function accessKey(wallet) {
  return `veil:access:until:${wallet.toLowerCase()}`;
}

function paymentKey(txHash) {
  return `veil:access:payment:${txHash.toLowerCase()}`;
}

async function getSzrBalance(wallet) {
  return publicClient.readContract({
    address: SZR_TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
}

async function getAccessUntil(wallet) {
  const raw = await redis.get(accessKey(wallet));
  const value = Number(raw || 0);
  return Number.isFinite(value) ? value : 0;
}

async function buildStatus(wallet) {
  const [balance, expiresAt] = await Promise.all([
    getSzrBalance(wallet),
    getAccessUntil(wallet),
  ]);

  const holdRequired = parseUnits(HOLD_REQUIRED_SZR, SZR_DECIMALS);
  const holdOk = balance >= holdRequired;
  const subscriptionActive = expiresAt > Date.now();
  const canSend = holdOk && subscriptionActive;

  return {
    ok: true,
    wallet: wallet.toLowerCase(),
    canRead: true,
    canSend,
    holdOk,
    subscriptionActive,
    balanceSzr: formatUnits(balance, SZR_DECIMALS),
    holdRequiredSzr: HOLD_REQUIRED_SZR,
    monthlyFeeSzr: MONTHLY_FEE_SZR,
    accessDays: ACCESS_DAYS,
    expiresAt,
    treasuryConfigured: isWallet(TREASURY_WALLET),
    treasuryWallet: isWallet(TREASURY_WALLET) ? TREASURY_WALLET : null,
    token: SZR_TOKEN,
  };
}

async function verifyPayment(wallet, txHash) {
  if (!isWallet(TREASURY_WALLET)) {
    throw new Error("VEIL_TREASURY_WALLET is not configured.");
  }

  const requiredFee = parseUnits(MONTHLY_FEE_SZR, SZR_DECIMALS);

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error("Payment transaction failed.");
  }

  const transaction = await publicClient.getTransaction({ hash: txHash });
  if (transaction.from.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error("Payment was not sent by this wallet.");
  }

  if ((transaction.to || "").toLowerCase() !== SZR_TOKEN.toLowerCase()) {
    throw new Error("Payment transaction did not call the SZR token.");
  }

  let paid = 0n;

  for (const log of receipt.logs) {
    if ((log.address || "").toLowerCase() !== SZR_TOKEN.toLowerCase()) continue;

    try {
      const decoded = decodeEventLog({
        abi: ERC20_ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName !== "Transfer") continue;

      const from = decoded.args.from?.toLowerCase();
      const to = decoded.args.to?.toLowerCase();
      const value = BigInt(decoded.args.value || 0);

      if (
        from === wallet.toLowerCase() &&
        to === TREASURY_WALLET &&
        value >= requiredFee
      ) {
        paid += value;
      }
    } catch {}
  }

  if (paid < requiredFee) {
    throw new Error(
      `Payment must transfer at least ${MONTHLY_FEE_SZR} SZR to the VEIL treasury.`
    );
  }

  const balanceAfter = await getSzrBalance(wallet);
  const holdRequired = parseUnits(HOLD_REQUIRED_SZR, SZR_DECIMALS);

  if (balanceAfter < holdRequired) {
    throw new Error(
      `Keep at least ${HOLD_REQUIRED_SZR} SZR in the wallet after payment to activate VEIL.`
    );
  }

  return { paid };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (!redis || !MASTER_KEY_B64) {
    return res.status(503).json({ error: "VEIL access service is not configured." });
  }

  if (req.method === "GET" && req.query?.action === "health") {
    return res.status(200).json({
      ok: true,
      holdRequiredSzr: HOLD_REQUIRED_SZR,
      monthlyFeeSzr: MONTHLY_FEE_SZR,
      accessDays: ACCESS_DAYS,
      treasuryConfigured: isWallet(TREASURY_WALLET),
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = req.body || {};
  const wallet = body.wallet;
  const sessionToken = body.sessionToken;

  if (!isWallet(wallet) || !verifySessionToken(sessionToken, wallet)) {
    return res.status(401).json({ error: "VEIL session expired." });
  }

  if (body.action === "status") {
    try {
      return res.status(200).json(await buildStatus(wallet));
    } catch (error) {
      console.error("VEIL access status:", error);
      return res.status(503).json({ error: "Could not verify SZR access on BNB Chain." });
    }
  }

  if (body.action === "activate") {
    const txHash = body.txHash;
    if (!isTxHash(txHash)) {
      return res.status(400).json({ error: "Invalid payment transaction hash." });
    }

    try {
      const existing = await redis.get(paymentKey(txHash));
      if (existing) {
        const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
        if (parsed?.wallet === wallet.toLowerCase()) {
          return res.status(200).json({
            ...(await buildStatus(wallet)),
            paymentAlreadyVerified: true,
          });
        }
        return res.status(409).json({ error: "Payment transaction already used." });
      }

      await verifyPayment(wallet, txHash);

      const currentUntil = await getAccessUntil(wallet);
      const base = Math.max(Date.now(), currentUntil);
      const expiresAt = base + ACCESS_MS;

      await redis.set(accessKey(wallet), String(expiresAt));
      await redis.set(
        paymentKey(txHash),
        JSON.stringify({ wallet: wallet.toLowerCase(), expiresAt }),
        { ex: 365 * 24 * 60 * 60 }
      );

      return res.status(201).json(await buildStatus(wallet));
    } catch (error) {
      console.error("VEIL access activation:", error);
      return res.status(400).json({
        error: error?.message || "Could not activate VEIL access.",
      });
    }
  }

  return res.status(400).json({ error: "Unknown action." });
}
