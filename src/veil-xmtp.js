import { Client, IdentifierKind, ConsentState } from "@xmtp/browser-sdk";
import {
  enableVeilPush,
  notifyVeilRecipient,
  requestVeilNotificationPermission,
} from "./veil-push.js";

const ENV = "production";
const CONVERSATION_API = "/api/veil-inbox";
const SESSION_STORAGE_PREFIX = "schizora_veil_session_";
const CONTACTS_PREFIX = "schizora_veil_contacts_";

let xmtp = null;
let activeDm = null;
let activePeerAddress = null;
let activeTransport = null;
let streamHandle = null;
let currentSessionToken = null;
let currentWallet = null;
let serverConversations = [];

const FREE_TRIAL_LIMIT = 50;

const $ = (id) => document.getElementById(id);

function normalizeWallet(value) {
  return String(value || "").toLowerCase();
}

function short(value) {
  const s = String(value || "");
  return s.length > 16 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function trialKey() {
  const a = normalizeWallet(window.account || "unknown");
  return `schizora_veil_trial_sent_${a}`;
}

function trialUsed() {
  return Number(localStorage.getItem(trialKey()) || "0");
}

function trialRemaining() {
  return Math.max(0, FREE_TRIAL_LIMIT - trialUsed());
}

function updateTrialUI() {
  const remaining = trialRemaining();
  const planStrong = document.querySelector(".plan div:first-child strong");
  if (planStrong) planStrong.textContent = `${remaining} / ${FREE_TRIAL_LIMIT} left`;
}

function consumeTrialMessage() {
  const used = trialUsed();
  if (used >= FREE_TRIAL_LIMIT) {
    throw new Error("Free trial complete: 50 messages used.");
  }
  localStorage.setItem(trialKey(), String(used + 1));
  updateTrialUI();
}

function uiStatus(message, error = false) {
  const el = $("veilChatStatus");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = error ? "#ff8fa4" : "";
}

function networkStatus(title, detail) {
  const el = $("veilNetworkStatus");
  if (el) el.innerHTML = `<b>${escapeHtml(title)}</b><br>${escapeHtml(detail)}`;
}

function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2) throw new Error("Invalid signature.");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function apiJson(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch {}
  return { response, data };
}

function sessionKey(wallet) {
  return `${SESSION_STORAGE_PREFIX}${normalizeWallet(wallet)}`;
}

function loadSession(wallet) {
  try {
    const raw = localStorage.getItem(sessionKey(wallet));
    if (!raw) return null;
    const session = JSON.parse(raw);

    if (!session?.token || Number(session.expiresAt) <= Date.now() + 60000) {
      localStorage.removeItem(sessionKey(wallet));
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

async function ensureVeilSession(walletAddress) {
  const wallet = normalizeWallet(walletAddress);
  const existing = loadSession(wallet);
  if (existing) {
    currentSessionToken = existing.token;
    return existing.token;
  }

  const timestamp = Date.now();
  const proof = [
    "SCHIZORA VEIL Session",
    "",
    "This signature authorizes this browser session for VEIL messaging.",
    "It does not authorize a token transfer.",
    "",
    `Wallet: ${wallet}`,
    `Timestamp: ${timestamp}`,
  ].join("\n");

  const signature = await window.ethereum.request({
    method: "personal_sign",
    params: [proof, walletAddress],
  });

  const result = await apiJson(CONVERSATION_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "session",
      wallet,
      timestamp,
      signature,
    }),
  });

  if (!result.response.ok || !result.data.token) {
    throw new Error(result.data.error || "Could not start VEIL session.");
  }

  const session = {
    token: result.data.token,
    expiresAt: result.data.expiresAt,
  };

  localStorage.setItem(sessionKey(wallet), JSON.stringify(session));
  currentSessionToken = session.token;
  return session.token;
}

function contactsKey(wallet) {
  return `${CONTACTS_PREFIX}${normalizeWallet(wallet)}`;
}

function loadLocalContacts(wallet) {
  try {
    const values = JSON.parse(localStorage.getItem(contactsKey(wallet)) || "[]");
    return Array.isArray(values) ? values.filter(isWallet) : [];
  } catch {
    return [];
  }
}

function saveLocalContact(wallet, peer) {
  const existing = new Set(loadLocalContacts(wallet).map(normalizeWallet));
  existing.add(normalizeWallet(peer));
  localStorage.setItem(contactsKey(wallet), JSON.stringify([...existing]));
}

function isWallet(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

async function ensureWallet() {
  if (!window.ethereum) {
    throw new Error(
      "Open SCHIZORA in MetaMask, Bitget Wallet, Trust Wallet, or another injected Web3 wallet."
    );
  }

  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!address) throw new Error("No wallet account selected.");

  window.account = address;
  currentWallet = address;

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
      identifier: normalizeWallet(address),
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
  networkStatus(
    "Initializing VEIL...",
    "Your wallet may request XMTP identity signatures."
  );

  xmtp = await Client.create(createXmtpSigner(address), {
    env: ENV,
    appVersion: "SCHIZORA-VEIL/0.6-CONVERSATIONS-60D",
  });

  networkStatus(
    "VEIL encrypted network online.",
    `XMTP inbox: ${short(xmtp.inboxId)}`
  );

  try {
    await xmtp.conversations.syncAll(["allowed", "unknown"]);
  } catch (error) {
    console.warn("Initial XMTP sync warning:", error);
  }

  startGlobalStream();
  return xmtp;
}

async function canReachXMTP(address) {
  const identifier = {
    identifier: normalizeWallet(address),
    identifierKind: IdentifierKind.Ethereum,
  };

  const reachable = await Client.canMessage([identifier], ENV);
  const can = reachable instanceof Map
    ? (
        reachable.get(normalizeWallet(address)) ??
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
      return (
        result.get(normalizeWallet(address)) ||
        result.get(address) ||
        [...result.values()][0]
      );
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
    if (message.content && typeof message.content.content === "string") {
      return message.content.content;
    }
  } catch {}
  return "[Unsupported encrypted content]";
}

function getSenderInboxId(message) {
  return (
    message.senderInboxId ||
    message.senderInboxID ||
    message.senderInbox ||
    ""
  );
}

function getSentDate(message) {
  const ns = message.sentAtNs ?? message.sentNs ?? message.sentAt ?? null;
  try {
    if (typeof ns === "bigint") return new Date(Number(ns / 1000000n));
    if (typeof ns === "number") {
      return ns > 1e14 ? new Date(ns / 1e6) : new Date(ns);
    }
    if (ns instanceof Date) return ns;
  } catch {}
  return new Date();
}

function installConversationUI() {
  if ($("veilConversationLayout")) return;

  const chat = $("veilChat");
  const target = chat?.querySelector(".target");
  const windowEl = $("chatWindow");
  const composer = chat?.querySelector(".composer");
  const status = $("veilChatStatus");

  if (!chat || !target || !windowEl || !composer || !status) return;

  const style = document.createElement("style");
  style.textContent = `
    #veilConversationLayout{
      display:grid;
      grid-template-columns:245px minmax(0,1fr);
      gap:12px;
      flex:1;
      min-height:0;
      margin-top:14px
    }
    #veilConversationSidebar{
      min-height:470px;
      border:1px solid rgba(213,105,255,.17);
      border-radius:18px;
      background:rgba(0,0,0,.22);
      overflow:hidden;
      display:flex;
      flex-direction:column
    }
    .veil-conv-title{
      padding:14px 14px 10px;
      font-size:11px;
      font-weight:900;
      letter-spacing:1.7px;
      color:#d8c3ef;
      text-transform:uppercase;
      border-bottom:1px solid rgba(213,105,255,.12)
    }
    #veilConversationList{
      padding:7px;
      overflow:auto;
      flex:1
    }
    .veil-conv-item{
      width:100%;
      display:block;
      text-align:left;
      color:#fff;
      border:0;
      background:transparent;
      border-radius:13px;
      padding:11px;
      margin:2px 0;
      cursor:pointer
    }
    .veil-conv-item:hover,
    .veil-conv-item.active{
      background:rgba(139,92,246,.15)
    }
    .veil-conv-wallet{
      display:block;
      font-family:monospace;
      font-weight:900;
      font-size:12px
    }
    .veil-conv-preview{
      display:block;
      color:#baa8cf;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
      margin-top:5px;
      font-size:11px
    }
    #veilThreadPane{
      min-width:0;
      display:flex;
      flex-direction:column
    }
    #veilActivePeerHeader{
      min-height:44px;
      padding:9px 12px;
      border:1px solid rgba(213,105,255,.14);
      border-radius:14px;
      background:rgba(255,255,255,.035);
      margin-bottom:8px;
      display:none
    }
    #veilActivePeerHeader strong{
      display:block;
      font-family:monospace;
      word-break:break-all
    }
    #veilActivePeerHeader small{color:#baa8cf}
    #veilThreadPane .target{margin:0 0 8px}
    #veilThreadPane .window{min-height:335px}
    @media(max-width:760px){
      #veilConversationLayout{grid-template-columns:1fr}
      #veilConversationSidebar{min-height:120px;max-height:190px}
      #veilThreadPane .window{min-height:300px}
    }
  `;
  document.head.appendChild(style);

  const layout = document.createElement("div");
  layout.id = "veilConversationLayout";

  const sidebar = document.createElement("aside");
  sidebar.id = "veilConversationSidebar";
  sidebar.innerHTML = `
    <div class="veil-conv-title">Conversations</div>
    <div id="veilConversationList">
      <div class="muted" style="padding:12px;font-size:12px">No conversations yet.</div>
    </div>
  `;

  const thread = document.createElement("section");
  thread.id = "veilThreadPane";

  const header = document.createElement("div");
  header.id = "veilActivePeerHeader";

  chat.insertBefore(layout, target);
  layout.append(sidebar, thread);
  thread.append(header, target, windowEl, composer, status);
}

async function listServerConversations() {
  if (!currentWallet || !currentSessionToken) return [];

  const result = await apiJson(CONVERSATION_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "list",
      wallet: normalizeWallet(currentWallet),
      sessionToken: currentSessionToken,
    }),
  });

  if (!result.response.ok) return [];

  serverConversations = Array.isArray(result.data.conversations)
    ? result.data.conversations
    : [];

  return serverConversations;
}

async function refreshConversationList() {
  const listEl = $("veilConversationList");
  if (!listEl || !currentWallet) return;

  await listServerConversations();

  const serverMap = new Map(
    serverConversations.map((item) => [normalizeWallet(item.peer), item])
  );

  const peers = new Set([
    ...loadLocalContacts(currentWallet).map(normalizeWallet),
    ...serverConversations.map((item) => normalizeWallet(item.peer)),
  ]);

  if (activePeerAddress) peers.add(normalizeWallet(activePeerAddress));

  const ordered = [...peers]
    .filter(isWallet)
    .sort((a, b) => {
      const ta = Number(serverMap.get(a)?.lastAt || 0);
      const tb = Number(serverMap.get(b)?.lastAt || 0);
      return tb - ta;
    });

  if (!ordered.length) {
    listEl.innerHTML =
      `<div class="muted" style="padding:12px;font-size:12px">No conversations yet.</div>`;
    return;
  }

  listEl.innerHTML = "";

  for (const peer of ordered) {
    const item = serverMap.get(peer);
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      `veil-conv-item${normalizeWallet(activePeerAddress) === peer ? " active" : ""}`;

    const walletLabel = document.createElement("span");
    walletLabel.className = "veil-conv-wallet";
    walletLabel.textContent = short(peer);

    const preview = document.createElement("span");
    preview.className = "veil-conv-preview";
    preview.textContent = item?.lastMessage || "Open conversation";

    button.append(walletLabel, preview);

    button.addEventListener("click", () => {
      const recipient = $("recipient");
      if (recipient) recipient.value = peer;
      openConversation().catch((error) => {
        console.error(error);
        uiStatus(error?.message || "Could not open conversation.", true);
      });
    });

    listEl.appendChild(button);
  }
}

function setActiveHeader(peer) {
  const header = $("veilActivePeerHeader");
  if (!header) return;

  if (!peer) {
    header.style.display = "none";
    header.innerHTML = "";
    return;
  }

  header.style.display = "block";
  header.innerHTML = `
    <small>Conversation with</small>
    <strong>${escapeHtml(peer)}</strong>
  `;
}

async function getServerHistory(peer) {
  if (!currentWallet || !currentSessionToken || !peer) return [];

  const result = await apiJson(CONVERSATION_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "history",
      wallet: normalizeWallet(currentWallet),
      peer: normalizeWallet(peer),
      sessionToken: currentSessionToken,
    }),
  });

  if (!result.response.ok) return [];
  return Array.isArray(result.data.messages) ? result.data.messages : [];
}

async function getXmtpHistory() {
  if (!activeDm) return [];

  try {
    const messages = await activeDm.messages({
      limit: 100n,
      direction: "ascending",
    });

    const myInbox = xmtp?.inboxId || "";

    return messages.map((message) => ({
      id: `xmtp:${message.id || Math.random()}`,
      sender: getSenderInboxId(message) === myInbox
        ? normalizeWallet(currentWallet)
        : normalizeWallet(activePeerAddress),
      recipient: getSenderInboxId(message) === myInbox
        ? normalizeWallet(activePeerAddress)
        : normalizeWallet(currentWallet),
      message: getMessageText(message),
      createdAt: getSentDate(message).getTime(),
      transport: "xmtp",
    }));
  } catch (error) {
    console.warn("XMTP history warning:", error);
    return [];
  }
}

function renderMessages(messages) {
  const windowEl = $("chatWindow");
  if (!windowEl) return;

  if (!messages.length) {
    windowEl.innerHTML = `
      <div>
        <div style="font-size:38px">◇</div>
        <b>Conversation ready.</b>
        <div style="margin-top:8px">Write a message below.</div>
      </div>`;
    return;
  }

  const list = document.createElement("div");
  list.className = "msg-list";

  for (const message of messages) {
    const mine =
      normalizeWallet(message.sender) === normalizeWallet(currentWallet);

    const row = document.createElement("div");
    row.className = `msg-row ${mine ? "mine" : "theirs"}`;

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";

    const content = document.createElement("div");
    content.textContent = message.message;

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent =
      `${mine ? "You" : short(activePeerAddress)} • ` +
      `${new Date(message.createdAt).toLocaleString()}`;

    bubble.append(content, meta);
    row.appendChild(bubble);
    list.appendChild(row);
  }

  windowEl.innerHTML = "";
  windowEl.appendChild(list);
  windowEl.scrollTop = windowEl.scrollHeight;
}

async function renderActiveConversation() {
  const windowEl = $("chatWindow");
  if (!windowEl || !activePeerAddress) return;

  windowEl.innerHTML =
    `<div class="chat-loading">Loading conversation...</div>`;

  const [serverMessages, xmtpMessages] = await Promise.all([
    getServerHistory(activePeerAddress),
    getXmtpHistory(),
  ]);

  const seen = new Set();
  const merged = [...serverMessages, ...xmtpMessages]
    .filter((item) => {
      const key =
        `${normalizeWallet(item.sender)}|${Number(item.createdAt)}|${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

  renderMessages(merged);
}

async function openConversation() {
  try {
    if (!xmtp) await initializeXMTP();

    const address = $("recipient")?.value?.trim();
    if (!isWallet(address)) {
      throw new Error("Enter a valid BSC wallet address.");
    }

    const myAddress = normalizeWallet(await ensureWallet());
    if (normalizeWallet(address) === myAddress) {
      throw new Error("Choose another wallet address.");
    }

    uiStatus("Opening conversation...");
    activePeerAddress = normalizeWallet(address);
    saveLocalContact(currentWallet, activePeerAddress);
    setActiveHeader(activePeerAddress);

    const reach = await canReachXMTP(address);

    if (reach.can) {
      const inboxId = await resolveInboxId(address, reach.identifier);
      activeDm = await xmtp.conversations.createDm(inboxId);
      activeTransport = "xmtp";
    } else {
      activeDm = null;
      activeTransport = "veil-pending";
    }

    const input = $("veilMessageInput");
    const send = $("veilSendBtn");

    input.disabled = false;
    send.disabled = false;
    input.placeholder = `Message ${short(activePeerAddress)}...`;

    uiStatus("");
    await refreshConversationList();
    await renderActiveConversation();
    input.focus();
  } catch (error) {
    console.error(error);
    uiStatus(error?.message || "Could not open conversation.", true);
    window.toastMsg?.(error?.message || "Could not open conversation.");
  }
}

async function sendServerMessage(text) {
  const result = await apiJson(CONVERSATION_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "send",
      sender: normalizeWallet(currentWallet),
      recipient: normalizeWallet(activePeerAddress),
      sessionToken: currentSessionToken,
      message: text,
    }),
  });

  if (result.response.status === 401) {
    localStorage.removeItem(sessionKey(currentWallet));
    throw new Error("VEIL session expired. Re-enter VEIL to continue.");
  }

  if (!result.response.ok) {
    throw new Error(result.data.error || "Message failed.");
  }
}

async function sendMessage() {
  const input = $("veilMessageInput");
  const button = $("veilSendBtn");

  if (!activePeerAddress || !input || input.disabled) return;

  const text = input.value.trim();
  if (!text) return;

  if (trialRemaining() <= 0) {
    uiStatus("Free trial complete: 50 messages used.", true);
    return;
  }

  try {
    button.disabled = true;
    uiStatus("Sending...");

    if (activeTransport === "xmtp" && activeDm) {
      await activeDm.sendText(text, true);
      await activeDm.publishMessages();
    } else {
      await sendServerMessage(text);
    }

    input.value = "";
    consumeTrialMessage();
    saveLocalContact(currentWallet, activePeerAddress);

    notifyVeilRecipient(activePeerAddress).catch(() => {});

    uiStatus(`Sent • ${trialRemaining()} free messages left.`);
    await refreshConversationList();
    await renderActiveConversation();
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
        if (activeDm) {
          await renderActiveConversation();
        }
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

    installConversationUI();

    const wallet = await ensureWallet();

    // One VEIL authorization signature for up to 60 days on this browser/device.
    // Individual messages do not request a new wallet signature.
    currentSessionToken = await ensureVeilSession(wallet);

    let pushReady = false;
    if (notificationPermission === "granted") {
      try {
        await enableVeilPush(wallet);
        pushReady = true;
      } catch (error) {
        console.warn("VEIL push registration warning:", error);
      }
    }

    await refreshConversationList();

    if (pushReady) {
      networkStatus(
        "VEIL encrypted network online.",
        `XMTP inbox: ${short(xmtp.inboxId)} • Push alerts enabled`
      );
    }

    uiStatus(
      pushReady
        ? "VEIL is ready. Open a conversation and chat."
        : "VEIL is ready. Open a conversation and chat."
    );

    window.toastMsg?.("VEIL conversations ready.");
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

window.VEIL = {
  enter,
  openConversation,
  sendMessage,
};

bind();
updateTrialUI();
