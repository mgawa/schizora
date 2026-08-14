import { Client, IdentifierKind, ConsentState } from "@xmtp/browser-sdk";
import {
  enableVeilPush,
  notifyVeilRecipient,
  requestVeilNotificationPermission,
} from "./veil-push.js";

const ENV = "production";
const PENDING_API = "/api/veil-inbox";

let xmtp = null;
let activeDm = null;
let activePeerAddress = null;
let activeTransport = null;
let streamHandle = null;
let claimedPendingMessages = [];

const FREE_TRIAL_LIMIT = 50;

function trialKey() {
  const a = (window.account || "unknown").toLowerCase();
  return `schizora_veil_trial_sent_${a}`;
}
function trialUsed() { return Number(localStorage.getItem(trialKey()) || "0"); }
function trialRemaining() { return Math.max(0, FREE_TRIAL_LIMIT - trialUsed()); }
function updateTrialUI() {
  const remaining = trialRemaining();
  const planStrong = document.querySelector(".plan div:first-child strong");
  if (planStrong) planStrong.textContent = `${remaining} / ${FREE_TRIAL_LIMIT} left`;
}
function consumeTrialMessage() {
  const used = trialUsed();
  if (used >= FREE_TRIAL_LIMIT) throw new Error("Free trial complete: 50 messages used.");
  localStorage.setItem(trialKey(), String(used + 1));
  updateTrialUI();
}

const $ = (id) => document.getElementById(id);

function uiStatus(message, error = false) {
  const el = $("veilChatStatus");
  if (el) {
    el.textContent = message || "";
    el.style.color = error ? "#ff8fa4" : "";
  }
}

function networkStatus(title, detail) {
  const el = $("veilNetworkStatus");
  if (el) el.innerHTML = `<b>${escapeHtml(title)}</b><br>${escapeHtml(detail)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2) throw new Error("Invalid signature.");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function apiJson(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch {}
  return { response, data };
}

async function ensureWallet() {
  if (!window.ethereum) {
    throw new Error("Open SCHIZORA in MetaMask, Bitget Wallet, Trust Wallet, or another injected Web3 wallet.");
  }

  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("No wallet account selected.");

  window.account = address;

  const walletBtn = $("walletBtn");
  const veilWallet = $("veilWallet");
  if (walletBtn) walletBtn.textContent = `${address.slice(0, 6)}...${address.slice(-4)}`;
  if (veilWallet) veilWallet.textContent = address;

  updateTrialUI();
  return address;
}

function createXmtpSigner(address) {
  return {
    type: "EOA",
    getIdentifier: () => ({
      identifier: address.toLowerCase(),
      identifierKind: IdentifierKind.Ethereum,
    }),
    signMessage: async (message) => {
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [message, address],
      });
      return hexToBytes(signature);
    },
  };
}

async function initializeXMTP() {
  if (xmtp) return xmtp;

  const address = await ensureWallet();
  networkStatus("Initializing VEIL...", "Your wallet may request XMTP identity signatures.");

  const signer = createXmtpSigner(address);
  xmtp = await Client.create(signer, {
    env: ENV,
    appVersion: "SCHIZORA-VEIL/0.3-ANY-BSC",
  });

  networkStatus("VEIL encrypted network online.", `XMTP inbox: ${short(xmtp.inboxId)}`);

  try {
    await xmtp.conversations.syncAll(["allowed", "unknown"]);
  } catch (error) {
    console.warn("Initial XMTP sync warning:", error);
  }

  startGlobalStream();
  return xmtp;
}

function short(value) {
  const s = String(value || "");
  return s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s;
}

async function canReachXMTP(address) {
  const identifier = {
    identifier: address.toLowerCase(),
    identifierKind: IdentifierKind.Ethereum,
  };

  const reachable = await Client.canMessage([identifier], ENV);
  const can = reachable instanceof Map
    ? (
        reachable.get(address.toLowerCase()) ??
        reachable.get(address) ??
        [...reachable.values()][0]
      )
    : false;

  return { can: Boolean(can), identifier };
}

async function resolveInboxId(address, identifier) {
  if (typeof xmtp.findInboxIdByIdentities === "function") {
    const result = await xmtp.findInboxIdByIdentities([identifier]);
    if (Array.isArray(result)) return result[0];
    if (result instanceof Map) {
      return result.get(address.toLowerCase()) || result.get(address) || [...result.values()][0];
    }
    if (typeof result === "string") return result;
  }

  if (typeof xmtp.findInboxIdByIdentifier === "function") {
    const result = await xmtp.findInboxIdByIdentifier(identifier);
    if (result) return result;
  }

  if (typeof xmtp.findInboxIdFromIdentity === "function") {
    const result = await xmtp.findInboxIdFromIdentity(identifier);
    if (result) return result;
  }

  if (typeof Client.getOrCreateInboxId === "function") {
    const result = await Client.getOrCreateInboxId(identifier, ENV);
    if (result) return result;
  }

  throw new Error("XMTP inbox lookup failed.");
}

function getMessageText(message) {
  try {
    if (typeof message.content === "function") {
      const c = message.content();
      if (typeof c === "string") return c;
      if (c && typeof c.content === "string") return c.content;
      if (c != null) return String(c);
    }
    if (typeof message.content === "string") return message.content;
    if (message.content && typeof message.content.content === "string") return message.content.content;
  } catch {}
  return "[Unsupported encrypted content]";
}

function getSenderInboxId(message) {
  return message.senderInboxId || message.senderInboxID || message.senderInbox || "";
}

function getSentDate(message) {
  const ns = message.sentAtNs ?? message.sentNs ?? message.sentAt ?? null;
  try {
    if (typeof ns === "bigint") return new Date(Number(ns / 1000000n));
    if (typeof ns === "number") return ns > 1e14 ? new Date(ns / 1e6) : new Date(ns);
    if (ns instanceof Date) return ns;
  } catch {}
  return new Date();
}

function renderClaimedPendingInbox() {
  const windowEl = $("chatWindow");
  if (!windowEl || !claimedPendingMessages.length) return;

  const list = document.createElement("div");
  list.className = "msg-list";

  const title = document.createElement("div");
  title.style.cssText = "padding:10px 0 14px;font-weight:900;color:#fff";
  title.textContent = "VEIL messages waiting for this wallet";
  list.appendChild(title);

  for (const item of claimedPendingMessages) {
    const row = document.createElement("div");
    row.className = "msg-row theirs";

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";

    const content = document.createElement("div");
    content.textContent = item.message;

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = `${short(item.sender)} • ${new Date(item.createdAt).toLocaleString()}`;

    bubble.append(content, meta);
    row.appendChild(bubble);
    list.appendChild(row);
  }

  windowEl.innerHTML = "";
  windowEl.appendChild(list);
  windowEl.scrollTop = windowEl.scrollHeight;
}

async function claimPendingInboxIfAny(address) {
  try {
    const check = await apiJson(
      `${PENDING_API}?action=has-pending&wallet=${encodeURIComponent(address)}`
    );

    if (!check.response.ok || !check.data.hasPending) return [];

    const timestamp = Date.now();
    const proof = [
      "SCHIZORA VEIL Pending Inbox Claim",
      "",
      "This signature proves wallet ownership and unlocks pending VEIL messages.",
      "It does not authorize a token transfer.",
      "",
      `Wallet: ${address.toLowerCase()}`,
      `Timestamp: ${timestamp}`,
    ].join("\n");

    const signature = await window.ethereum.request({
      method: "personal_sign",
      params: [proof, address],
    });

    const result = await apiJson(PENDING_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "claim",
        wallet: address.toLowerCase(),
        timestamp,
        signature,
      }),
    });

    if (!result.response.ok) {
      console.warn("Pending inbox claim failed:", result.data);
      return [];
    }

    claimedPendingMessages = Array.isArray(result.data.messages)
      ? result.data.messages
      : [];

    if (claimedPendingMessages.length) {
      renderClaimedPendingInbox();
      window.toastMsg?.(`${claimedPendingMessages.length} VEIL message(s) received.`);
    }

    return claimedPendingMessages;
  } catch (error) {
    console.warn("Pending inbox warning:", error);
    return [];
  }
}

async function renderActiveConversation() {
  const windowEl = $("chatWindow");
  if (!windowEl) return;

  if (activeTransport === "pending") {
    windowEl.innerHTML = `
      <div>
        <div style="font-size:38px">◇</div>
        <b>VEIL channel ready.</b>
        <div style="margin-top:8px">Write your message below.</div>
      </div>`;
    return;
  }

  if (!activeDm) return;

  windowEl.innerHTML = `<div class="chat-loading">Decrypting conversation...</div>`;

  try {
    const messages = await activeDm.messages({ limit: 100n, direction: "ascending" });
    const myInbox = xmtp?.inboxId || "";

    if (!messages.length) {
      windowEl.innerHTML = `<div><div style="font-size:38px">◇</div><b>Encrypted channel ready.</b><div style="margin-top:8px">Send the first VEIL message to ${escapeHtml(short(activePeerAddress))}.</div></div>`;
      return;
    }

    const list = document.createElement("div");
    list.className = "msg-list";

    for (const message of messages) {
      const mine = getSenderInboxId(message) === myInbox;
      const row = document.createElement("div");
      row.className = `msg-row ${mine ? "mine" : "theirs"}`;
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble";

      const content = document.createElement("div");
      content.textContent = getMessageText(message);

      const meta = document.createElement("div");
      meta.className = "msg-meta";
      meta.textContent = `${mine ? "You" : short(activePeerAddress)} • ${getSentDate(message).toLocaleString()}`;

      bubble.append(content, meta);
      row.appendChild(bubble);
      list.appendChild(row);
    }

    windowEl.innerHTML = "";
    windowEl.appendChild(list);
    windowEl.scrollTop = windowEl.scrollHeight;
  } catch (error) {
    console.error(error);
    windowEl.innerHTML = `<div style="color:#ff8fa4">Could not decrypt/load this conversation.</div>`;
  }
}

async function openConversation() {
  try {
    if (!xmtp) await initializeXMTP();

    const address = $("recipient")?.value?.trim();
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new Error("Enter a valid BSC wallet address.");
    }

    const myAddress = (await ensureWallet()).toLowerCase();
    if (address.toLowerCase() === myAddress) throw new Error("Choose another wallet address.");

    uiStatus("Opening VEIL channel...");
    activePeerAddress = address;

    const reach = await canReachXMTP(address);

    if (reach.can) {
      const inboxId = await resolveInboxId(address, reach.identifier);
      activeDm = await xmtp.conversations.createDm(inboxId);
      activeTransport = "xmtp";
    } else {
      activeDm = null;
      activeTransport = "pending";
    }

    $("veilMessageInput").disabled = false;
    $("veilSendBtn").disabled = false;
    $("veilMessageInput").placeholder = "Write a message...";

    uiStatus(`VEIL channel open with ${short(address)}.`);
    await renderActiveConversation();
  } catch (error) {
    console.error(error);
    uiStatus(error?.message || "Could not open conversation.", true);
    window.toastMsg?.(error?.message || "Could not open conversation.");
  }
}

async function sendPendingMessage(text) {
  const sender = await ensureWallet();
  const recipient = activePeerAddress;
  const timestamp = Date.now();

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  const messageHash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const proof = [
    "SCHIZORA VEIL Pending Message",
    "",
    "This signature authorizes storing one pending VEIL message.",
    "It does not authorize a token transfer.",
    "",
    `Sender: ${sender.toLowerCase()}`,
    `Recipient: ${recipient.toLowerCase()}`,
    `Timestamp: ${timestamp}`,
    `Message SHA256: ${messageHash}`,
  ].join("\n");

  const signature = await window.ethereum.request({
    method: "personal_sign",
    params: [proof, sender],
  });

  const result = await apiJson(PENDING_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "send",
      sender: sender.toLowerCase(),
      recipient: recipient.toLowerCase(),
      timestamp,
      signature,
      message: text,
    }),
  });

  if (!result.response.ok) {
    throw new Error(result.data.error || "Message failed.");
  }

  notifyVeilRecipient(recipient).catch(() => {});
}

async function sendMessage() {
  const input = $("veilMessageInput");
  const button = $("veilSendBtn");
  if (!activePeerAddress || !input) return;

  const text = input.value.trim();
  if (!text) return;

  if (trialRemaining() <= 0) {
    uiStatus("Free trial complete: 50 messages used.", true);
    return;
  }

  try {
    button.disabled = true;
    uiStatus("Securing and sending...");

    if (activeTransport === "xmtp") {
      await activeDm.sendText(text, true);
      input.value = "";
      await renderActiveConversation();
      await activeDm.publishMessages();
      notifyVeilRecipient(activePeerAddress).catch(() => {});
    } else {
      await sendPendingMessage(text);
      input.value = "";
    }

    consumeTrialMessage();

    uiStatus(`Message sent. ${trialRemaining()} free messages left.`);
    window.toastMsg?.("VEIL message sent.");

    if (activeTransport === "xmtp") {
      await renderActiveConversation();
    } else {
      const windowEl = $("chatWindow");
      if (windowEl) {
        windowEl.innerHTML = `
          <div>
            <div style="font-size:38px">✓</div>
            <b>Message sent.</b>
            <div style="margin-top:8px">VEIL will make it available to the destination wallet.</div>
          </div>`;
      }
    }
  } catch (error) {
    console.error(error);
    uiStatus(error?.message || "Message failed.", true);
  } finally {
    button.disabled = false;
    input.focus();
  }
}

async function startGlobalStream() {
  if (!xmtp || streamHandle) return;

  try {
    streamHandle = await xmtp.conversations.streamAllMessages({
      consentStates: [ConsentState.Allowed, ConsentState.Unknown],
      onValue: async () => {
        if (activeDm) await renderActiveConversation();
      },
      onError: (error) => console.warn("VEIL stream:", error),
    });
  } catch (error) {
    console.warn("Could not start XMTP message stream:", error);
  }
}

async function enter() {
  const accepted =
    $("termsCheck")?.checked ||
    localStorage.getItem("veil_terms") === "1";

  if (!accepted) {
    window.toastMsg?.("Please accept the VEIL privacy terms first.");
    return;
  }

  localStorage.setItem("veil_terms", "1");

  let notificationPermission = "unsupported";
  try {
    notificationPermission = await requestVeilNotificationPermission();
  } catch (error) {
    console.warn("Notification permission warning:", error);
  }

  try {
    uiStatus("Connecting to VEIL...");
    await initializeXMTP();

    $("veilGate").style.display = "none";
    $("veilChat").classList.add("open");

    let pushReady = false;
    if (notificationPermission === "granted") {
      try {
        await enableVeilPush(window.account);
        pushReady = true;
      } catch (error) {
        console.warn("VEIL push registration warning:", error);
      }
    }

    const pending = await claimPendingInboxIfAny(window.account);

    if (pushReady) {
      networkStatus(
        "VEIL encrypted network online.",
        `XMTP inbox: ${short(xmtp.inboxId)} • Push alerts enabled`
      );
    }

    if (!pending.length) {
      uiStatus(
        pushReady
          ? "VEIL is ready. Messaging and push alerts are enabled."
          : "VEIL is ready."
      );
    }

    window.toastMsg?.("VEIL initialized.");
  } catch (error) {
    console.error(error);
    uiStatus(error?.message || "VEIL initialization failed.", true);
    window.toastMsg?.(error?.message || "VEIL initialization failed.");
  }
}

function bind() {
  $("openConversationBtn")?.addEventListener("click", openConversation);
  $("veilSendBtn")?.addEventListener("click", sendMessage);

  $("veilMessageInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
}

window.VEIL = { enter, openConversation, sendMessage };

bind();
updateTrialUI();
