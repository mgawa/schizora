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
let composingNewConversation = false;

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
    appVersion: "SCHIZORA-VEIL/0.7-SIMPLE-UI",
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

  const openButton = $("openConversationBtn");
  if (openButton) openButton.style.display = "none";

  const style = document.createElement("style");
  style.textContent = `
    #veilModal .modal-inner{
      background:#0a0610!important;
      box-shadow:0 24px 70px rgba(0,0,0,.48)!important
    }
    #veilModal .veil-shell{
      background:#0a0610!important
    }
    #veilModal .veil-side{
      background:#100919!important;
      border-color:rgba(182,108,255,.14)!important
    }
    #veilModal .veil-main{
      background:#0c0712!important
    }
    #veilConversationLayout{
      display:grid;
      grid-template-columns:250px minmax(0,1fr);
      gap:12px;
      flex:1;
      min-height:0;
      margin-top:14px
    }
    #veilConversationSidebar{
      min-height:470px;
      border:1px solid rgba(182,108,255,.14);
      border-radius:18px;
      background:#120b1a;
      overflow:hidden;
      display:flex;
      flex-direction:column
    }
    .veil-conv-titlebar{
      min-height:54px;
      padding:9px 10px 9px 14px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      border-bottom:1px solid rgba(182,108,255,.11)
    }
    .veil-conv-title{
      font-size:11px;
      font-weight:900;
      letter-spacing:1.7px;
      color:#e2d5ef;
      text-transform:uppercase
    }
    #veilNewConversationBtn{
      border:1px solid rgba(182,108,255,.22);
      background:#1a1024;
      color:#fff;
      border-radius:11px;
      padding:8px 11px;
      font-weight:900;
      cursor:pointer
    }
    #veilNewConversationBtn:hover{
      background:#251333
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
      background:#21122d
    }
    .veil-conv-wallet{
      display:block;
      font-family:monospace;
      font-weight:900;
      font-size:12px;
      color:#f4eff8
    }
    .veil-conv-preview{
      display:block;
      color:#aa9bb8;
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
      min-height:50px;
      padding:10px 13px;
      border:1px solid rgba(182,108,255,.13);
      border-radius:14px;
      background:#120b1a;
      margin-bottom:8px;
      display:none
    }
    #veilActivePeerHeader strong{
      display:block;
      font-family:monospace;
      word-break:break-all;
      color:#fff
    }
    #veilActivePeerHeader small{color:#aa9bb8}
    #veilThreadPane .target{
      margin:0 0 8px;
      display:none;
      grid-template-columns:1fr
    }
    #veilThreadPane .target input{
      background:#120b1a!important;
      border:1px solid rgba(182,108,255,.16)!important;
      color:#fff!important;
      box-shadow:none!important
    }
    #veilThreadPane .window{
      min-height:335px;
      background:#08050c!important;
      border:1px solid rgba(182,108,255,.12)!important;
      color:#cfc2da!important
    }
    #veilThreadPane .composer textarea{
      background:#120b1a!important;
      border:1px solid rgba(182,108,255,.16)!important;
      color:#fff!important;
      box-shadow:none!important
    }
    #veilThreadPane .composer textarea::placeholder,
    #veilThreadPane .target input::placeholder{
      color:#807388
    }
    #veilThreadPane .composer .btn{
      background:linear-gradient(135deg,#7c21ff,#c63dea)!important;
      box-shadow:0 8px 24px rgba(124,33,255,.18)!important
    }
    #veilThreadPane .composer .btn:hover{
      box-shadow:0 10px 30px rgba(124,33,255,.26)!important
    }
    #veilModal .msg-row.mine .msg-bubble{
      background:linear-gradient(135deg,#6e28d9,#b535cf)!important;
      box-shadow:none!important
    }
    #veilModal .msg-row.theirs .msg-bubble{
      background:#17101e!important;
      border:1px solid rgba(182,108,255,.11)!important
    }
    #veilModal .msg-meta{
      color:#b6a8bf!important;
      opacity:.82!important
    }
    @media(max-width:760px){
      #veilConversationLayout{grid-template-columns:1fr}
      #veilConversationSidebar{min-height:118px;max-height:190px}
      #veilThreadPane .window{min-height:300px}
      #veilModal .modal-body{padding:18px!important}
    }
  `;
  document.head.appendChild(style);

  const layout = document.createElement("div");
  layout.id = "veilConversationLayout";

  const sidebar = document.createElement("aside");
  sidebar.id = "veilConversationSidebar";
  sidebar.innerHTML = `
    <div class="veil-conv-titlebar">
      <div class="veil-conv-title">Conversations</div>
      <button id="veilNewConversationBtn" type="button">+ New</button>
    </div>
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

  $("veilNewConversationBtn")?.addEventListener("click", startNewConversation);
}
function showTargetRow(show) {
  const target = $("veilChat")?.querySelector(".target");
  if (target) target.style.display = show ? "grid" : "none";
}

function startNewConversation() {
  composingNewConversation = true;
  activePeerAddress = null;
  activeDm = null;
  activeTransport = "veil-pending";

  const recipient = $("recipient");
  const input = $("veilMessageInput");
  const send = $("veilSendBtn");
  const windowEl = $("chatWindow");

  setActiveHeader(null);
  showTargetRow(true);

  if (recipient) {
    recipient.value = "";
    recipient.placeholder = "To: wallet address (0x...)";
    recipient.focus();
  }

  if (input) {
    input.disabled = false;
    input.value = "";
    input.placeholder = "Write a message...";
  }

  if (send) send.disabled = false;

  if (windowEl) {
    windowEl.innerHTML = `
      <div>
        <div style="font-size:34px">＋</div>
        <b>New message</b>
        <div style="margin-top:8px">Add the destination wallet above, write your message and press Send.</div>
      </div>`;
  }

  uiStatus("");
  refreshConversationList().catch(() => {});
}

async function prepareConversationTransport(address) {
  activePeerAddress = normalizeWallet(address);
  activeDm = null;
  activeTransport = "veil-pending";

  try {
    const reach = await canReachXMTP(address);

    if (reach.can) {
      try {
        const inboxId = await resolveInboxId(address, reach.identifier);

        if (inboxId) {
          activeDm = await xmtp.conversations.createDm(inboxId);
          activeTransport = "xmtp";
        }
      } catch (error) {
        console.warn(
          "XMTP lookup failed; using VEIL fallback conversation instead:",
          error
        );
        activeDm = null;
        activeTransport = "veil-pending";
      }
    }
  } catch (error) {
    console.warn("XMTP reachability check failed; using VEIL fallback:", error);
    activeDm = null;
    activeTransport = "veil-pending";
  }

  return activeTransport;
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
      composingNewConversation = false;
      const recipient = $("recipient");
      if (recipient) recipient.value = peer;
      showTargetRow(false);
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
    composingNewConversation = false;

    await prepareConversationTransport(address);

    saveLocalContact(currentWallet, activePeerAddress);
    setActiveHeader(activePeerAddress);
    showTargetRow(false);

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

  if (!input || input.disabled) return;

  const text = input.value.trim();
  if (!text) return;

  if (trialRemaining() <= 0) {
    uiStatus("Free trial complete: 50 messages used.", true);
    return;
  }

  try {
    button.disabled = true;

    if (composingNewConversation || !activePeerAddress) {
      const address = $("recipient")?.value?.trim();

      if (!isWallet(address)) {
        throw new Error("Enter a valid destination wallet address.");
      }

      const myAddress = normalizeWallet(await ensureWallet());
      if (normalizeWallet(address) === myAddress) {
        throw new Error("Choose another wallet address.");
      }

      uiStatus("Creating conversation...");
      await prepareConversationTransport(address);
      saveLocalContact(currentWallet, activePeerAddress);
    }

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

    composingNewConversation = false;
    setActiveHeader(activePeerAddress);
    showTargetRow(false);

    const recipient = $("recipient");
    if (recipient) recipient.value = activePeerAddress;

    input.placeholder = `Message ${short(activePeerAddress)}...`;

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
    composingNewConversation = false;
    showTargetRow(false);
    setActiveHeader(null);

    const messageInput = $("veilMessageInput");
    const sendButton = $("veilSendBtn");
    if (messageInput) {
      messageInput.disabled = true;
      messageInput.placeholder = "Choose a conversation or press + New.";
    }
    if (sendButton) sendButton.disabled = true;

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
