
import { Client, IdentifierKind, ConsentState } from "@xmtp/browser-sdk";

const ENV = "production";
let xmtp = null;
let activeDm = null;
let activePeerAddress = null;
let streamHandle = null;
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

async function ensureWallet() {
  if (!window.ethereum) throw new Error("Open SCHIZORA in MetaMask, Bitget Wallet, Trust Wallet, or another injected Web3 wallet.");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("No wallet account selected.");

  // Keep the existing SCHIZORA wallet UI synchronized.
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
      // personal_sign produces the ERC-191 style signature XMTP expects for an EOA signer.
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
    appVersion: "SCHIZORA-VEIL/0.1",
  });

  networkStatus("VEIL encrypted network online.", `XMTP inbox: ${short(xmtp.inboxId)}`);

  // Sync existing conversations and catch up on messages.
  try {
    await xmtp.conversations.syncAll(["allowed", "unknown"]);
  } catch (e) {
    console.warn("Initial XMTP sync warning:", e);
  }

  startGlobalStream();
  return xmtp;
}

function short(v) {
  const s = String(v || "");
  return s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s;
}

async function resolveInboxId(address) {
  const identifier = {
    identifier: address.toLowerCase(),
    identifierKind: IdentifierKind.Ethereum,
  };

  const reachable = await Client.canMessage([identifier], ENV);
  const can = reachable instanceof Map
    ? (reachable.get(address.toLowerCase()) ?? reachable.get(address) ?? [...reachable.values()][0])
    : false;

  if (!can) {
    throw new Error("This wallet is not reachable on VEIL yet. The owner must connect to VEIL once to register its encrypted inbox.");
  }

  // Browser SDK APIs have evolved. Use the current identity lookup when available,
  // with compatible fallbacks for adjacent SDK releases.
  if (typeof xmtp.findInboxIdByIdentities === "function") {
    const result = await xmtp.findInboxIdByIdentities([identifier]);
    if (Array.isArray(result)) return result[0];
    if (result instanceof Map) return result.get(address.toLowerCase()) || result.get(address) || [...result.values()][0];
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

  throw new Error("Your installed XMTP Browser SDK does not expose the inbox lookup expected by this build. Update @xmtp/browser-sdk.");
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

async function renderActiveConversation() {
  const windowEl = $("chatWindow");
  if (!activeDm || !windowEl) return;

  windowEl.innerHTML = `<div class="chat-loading">Decrypting conversation...</div>`;
  try {
    const messages = await activeDm.messages({
      limit: 100n,
      direction: "ascending",
    });

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
  } catch (e) {
    console.error(e);
    windowEl.innerHTML = `<div style="color:#ff8fa4">Could not decrypt/load this conversation.</div>`;
  }
}

async function openConversation() {
  try {
    if (!xmtp) await initializeXMTP();
    const address = $("recipient")?.value?.trim();
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("Enter a valid EVM wallet address.");
    const myAddress = (await ensureWallet()).toLowerCase();
    if (address.toLowerCase() === myAddress) throw new Error("Choose another wallet address.");

    uiStatus("Locating recipient encrypted inbox...");
    const inboxId = await resolveInboxId(address);

    activeDm = await xmtp.conversations.createDm(inboxId);
    activePeerAddress = address;

    $("veilMessageInput").disabled = false;
    $("veilSendBtn").disabled = false;
    $("veilMessageInput").placeholder = "Write an end-to-end encrypted message...";
    uiStatus(`Encrypted DM open with ${short(address)}.`);
    await renderActiveConversation();
  } catch (e) {
    console.error(e);
    uiStatus(e?.message || "Could not open conversation.", true);
    window.toastMsg?.(e?.message || "Could not open conversation.");
  }
}

async function sendMessage() {
  const input = $("veilMessageInput");
  const button = $("veilSendBtn");
  if (!activeDm || !input) return;

  const text = input.value.trim();
  if (!text) return;
  if (trialRemaining() <= 0) { uiStatus("Free trial complete: 50 messages used.", true); return; }

  try {
    button.disabled = true;
    uiStatus("Encrypting and sending...");
    // Optimistic local send, then publish to XMTP network.
    await activeDm.sendText(text, true);
    input.value = "";
    await renderActiveConversation();
    await activeDm.publishMessages();
    consumeTrialMessage();
    uiStatus(`Encrypted message delivered. ${trialRemaining()} free messages left.`);
    await renderActiveConversation();
  } catch (e) {
    console.error(e);
    uiStatus(e?.message || "Message failed.", true);
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
      onValue: async (message) => {
        // Refresh current DM. The message body remains handled by XMTP's encrypted transport.
        if (activeDm) await renderActiveConversation();

        if (document.hidden && "Notification" in window && Notification.permission === "granted") {
          new Notification("SCHIZORA VEIL", { body: "New encrypted message received." });
        }
      },
      onError: (error) => console.warn("VEIL stream:", error),
    });
  } catch (e) {
    console.warn("Could not start XMTP message stream:", e);
  }
}

async function enter() {
  const accepted = $("termsCheck")?.checked || localStorage.getItem("veil_terms") === "1";
  if (!accepted) {
    window.toastMsg?.("Please accept the VEIL privacy terms first.");
    return;
  }
  localStorage.setItem("veil_terms", "1");

  try {
    uiStatus("Connecting to encrypted network...");
    await initializeXMTP();

    $("veilGate").style.display = "none";
    $("veilChat").classList.add("open");

    if ("Notification" in window && Notification.permission === "default") {
      // Optional foreground/background-tab notification. True closed-browser Web Push requires the push server stage.
      Notification.requestPermission().catch(() => {});
    }

    uiStatus("VEIL is ready. Enter another registered wallet address.");
    window.toastMsg?.("VEIL encrypted messaging initialized.");
  } catch (e) {
    console.error(e);
    uiStatus(e?.message || "VEIL initialization failed.", true);
    window.toastMsg?.(e?.message || "VEIL initialization failed.");
  }
}

function bind() {
  $("openConversationBtn")?.addEventListener("click", openConversation);
  $("veilSendBtn")?.addEventListener("click", sendMessage);
  $("veilMessageInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

window.VEIL = { enter, openConversation, sendMessage };
bind();
updateTrialUI();
