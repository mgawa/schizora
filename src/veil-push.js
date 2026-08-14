const PUSH_API = "/api/veil-push";
const REGISTRATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function b64ToU8(value) {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const b64 = (value + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function registrationKey(wallet) {
  return `schizora_veil_push_registered_${String(wallet || "").toLowerCase()}`;
}

function registrationIsFresh(wallet) {
  const ts = Number(localStorage.getItem(registrationKey(wallet)) || "0");
  return ts > 0 && Date.now() - ts < REGISTRATION_MAX_AGE_MS;
}

async function apiJson(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch {}
  return { response, data };
}

export async function requestVeilNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}

export async function enableVeilPush(walletAddress) {
  if (!walletAddress) throw new Error("Connect the wallet first.");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Web Push is not supported in this browser.");
  }
  if (!("Notification" in window) || Notification.permission !== "granted") {
    throw new Error("Notifications are not enabled.");
  }
  if (!window.ethereum) throw new Error("Wallet provider unavailable.");

  const wallet = walletAddress.toLowerCase();
  const registration = await navigator.serviceWorker.register("/veil-sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  const { response: keyResponse, data: keyData } = await apiJson(`${PUSH_API}?action=vapid`);
  if (!keyResponse.ok || !keyData.publicKey) {
    throw new Error("VEIL notification service is not configured.");
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToU8(keyData.publicKey),
    });
  }

  // Avoid asking for a wallet signature on every VEIL entry.
  if (registrationIsFresh(wallet)) return true;

  const timestamp = Date.now();
  const proofMessage = [
    "SCHIZORA VEIL Push Registration",
    "",
    "This signature registers this browser for generic VEIL message alerts.",
    "It does not authorize a token transfer.",
    "",
    `Wallet: ${wallet}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");

  const signature = await window.ethereum.request({
    method: "personal_sign",
    params: [proofMessage, walletAddress],
  });

  const { response, data } = await apiJson(PUSH_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "subscribe",
      wallet,
      timestamp,
      signature,
      subscription: subscription.toJSON(),
    }),
  });

  if (!response.ok) {
    throw new Error(data.error || "Could not register VEIL notifications.");
  }

  localStorage.setItem(registrationKey(wallet), String(Date.now()));
  return true;
}

export async function notifyVeilRecipient(recipientWallet) {
  if (!recipientWallet) return false;

  // Privacy boundary: the endpoint receives ONLY the recipient wallet.
  // Never pass message text, sender identity, conversation ID, or XMTP payload.
  const { response } = await apiJson(PUSH_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "notify",
      wallet: recipientWallet.toLowerCase(),
    }),
  });

  // No subscription is not a message-send failure.
  if (response.status === 404 || response.status === 429) return false;
  if (!response.ok) throw new Error("Push alert could not be delivered.");
  return true;
}

function openVeilFromHash() {
  if (location.hash !== "#veil") return;
  setTimeout(() => window.openVeil?.(), 0);
}

window.addEventListener("hashchange", openVeilFromHash);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", openVeilFromHash, { once: true });
} else {
  openVeilFromHash();
}
