// ═══════════════════════════════════════════════════════════
//  SP MD BOT — index.js
//  WhatsApp Bot powered by Baileys + Gemini 2.5
// ═══════════════════════════════════════════════════════════

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage,
} from "@whiskeysockets/baileys";

import { GoogleGenerativeAI } from "@google/generative-ai";
import express from "express";
import { createServer } from "http";
import { Server as SocketIO } from "socket.io";
import cors from "cors";
import fs from "fs";
import path from "path";
import readline from "readline";
import cron from "node-cron";
import NodeCache from "node-cache";
import axios from "axios";
import { fileURLToPath } from "url";
import pino from "pino";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Logger (silent for clean output) ───────────────────────
const logger = pino({ level: "silent" });

// ─── Config & State ─────────────────────────────────────────
const CONFIG_FILE = "./config.json";
const ADVICE_FILE = "./advice.json";
const STRIKES_FILE = "./strikes.json";
const ACTIVITY_FILE = "./activity.json";
const SESSION_DIR = "./auth_info_baileys";

const DEFAULT_CONFIG = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  ADMIN_NUMBER: process.env.ADMIN_NUMBER || "",
  LANDING_PAGE_URL: process.env.LANDING_PAGE_URL || "",
  features: {
    imageModeration: true,
    linkBan: true,
    batchApproval: true,
    antiCall: true,
    smartMarketing: true,
    antiForeign: false,
    strikeSystem: true,
    autoVanish: true,
    ytDownloader: true,
    requestSystem: true,
    silentHours: true,
    videoSticker: true,
    autoTranslate: true,
    fakeNewsDetector: true,
    activityTracker: true,
    imageGeneration: true,
  },
  silentHoursStart: 23,
  silentHoursEnd: 6,
  marketingHoursStart: 19,
  marketingHoursEnd: 22,
};

// ─── Helpers ─────────────────────────────────────────────────
function loadJSON(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) { console.error(`Error loading ${file}:`, e.message); }
  return fallback;
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error(`Error saving ${file}:`, e.message); }
}

let config = loadJSON(CONFIG_FILE, DEFAULT_CONFIG);
config.features = { ...DEFAULT_CONFIG.features, ...config.features };

let strikes = loadJSON(STRIKES_FILE, {});
let activity = loadJSON(ACTIVITY_FILE, {});
const msgCache = new NodeCache({ stdTTL: 3600 });
const vanishQueue = [];

// ─── Gemini Setup ────────────────────────────────────────────
let genAI, geminiModel, geminiVision;

function initGemini() {
  const key = config.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) return console.warn("⚠️  No Gemini API key set.");
  try {
    genAI = new GoogleGenerativeAI(key);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-05-20" });
    geminiVision = genAI.getGenerativeModel({ model: "gemini-2.5-flash-preview-05-20" });
    console.log("✅ Gemini initialized.");
  } catch (e) { console.error("Gemini init error:", e.message); }
}
initGemini();

async function geminiChat(prompt, systemContext = "") {
  if (!geminiModel) return null;
  try {
    const advice = loadJSON(ADVICE_FILE, {}).advice || "";
    const fullPrompt = `${advice}\n\n${systemContext}\n\nUser: ${prompt}`;
    const result = await geminiModel.generateContent(fullPrompt);
    return result.response.text();
  } catch (e) {
    console.error("Gemini chat error:", e.message);
    return null;
  }
}

async function geminiVisionCheck(imageBase64, mimeType = "image/jpeg") {
  if (!geminiVision) return { safe: true };
  try {
    const result = await geminiVision.generateContent([
      {
        inlineData: { data: imageBase64, mimeType },
      },
      `Analyze this image carefully. Is it: 
      1. A nude/explicit photo showing genitalia or intimate body parts?
      2. An amateur self-exposed photo?
      Answer ONLY with JSON: {"explicit": true/false, "confidence": 0-100, "reason": "brief reason"}`,
    ]);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (e) {
    console.error("Vision check error:", e.message);
    return { explicit: false, confidence: 0, reason: "check failed" };
  }
}

async function geminiTranslate(text) {
  if (!geminiModel) return text;
  try {
    const result = await geminiModel.generateContent(
      `Detect the language of this text. If it is NOT Sinhala or English, translate it to Sinhala. 
      If it's already Sinhala or English, return the original.
      Text: "${text}"
      Return ONLY the translated/original text with no explanation.`
    );
    return result.response.text().trim();
  } catch (e) { return text; }
}

async function geminiFakeNews(url) {
  if (!geminiModel) return null;
  try {
    const result = await geminiModel.generateContent(
      `Analyze this URL/claim for potential fake news or misinformation: "${url}"
      Return JSON: {"suspicious": true/false, "confidence": 0-100, "reason": "brief reason", "verdict": "FAKE/REAL/UNVERIFIED"}`
    );
    const text = result.response.text().replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (e) { return null; }
}

async function geminiGenerateImage(prompt) {
  // Gemini image generation via Imagen (returns description + placeholder)
  if (!geminiModel) return null;
  try {
    const result = await geminiModel.generateContent(
      `Create a detailed visual description for this image prompt that could be used with an image generator: "${prompt}".
      Also provide a URL from pollinations.ai in format: https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}
      Return JSON: {"description": "...", "imageUrl": "https://image.pollinations.ai/prompt/..."}`
    );
    const text = result.response.text().replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (e) { return null; }
}

// ─── Express + Socket.IO Dashboard ──────────────────────────
const app = express();
const httpServer = createServer(app);
const io = new SocketIO(httpServer, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/api/config", (req, res) => res.json(config));

app.post("/api/config", (req, res) => {
  config = { ...config, ...req.body };
  config.features = { ...config.features, ...(req.body.features || {}) };
  saveJSON(CONFIG_FILE, config);
  initGemini();
  io.emit("config_updated", config);
  res.json({ success: true });
});

app.post("/api/advice", (req, res) => {
  const advice = loadJSON(ADVICE_FILE, {});
  advice.advice = req.body.advice;
  advice.lastUpdated = new Date().toISOString();
  advice.updatedBy = "dashboard";
  saveJSON(ADVICE_FILE, advice);
  res.json({ success: true });
});

app.get("/api/advice", (req, res) => res.json(loadJSON(ADVICE_FILE, {})));

app.get("/api/stats", (req, res) => {
  res.json({
    strikes: strikes,
    activity: activity,
    vanishQueueSize: vanishQueue.length,
  });
});

app.post("/api/batch-approve", async (req, res) => {
  if (global.botSocket) {
    try {
      const groups = await global.botSocket.groupFetchAllParticipating();
      let approved = 0;
      for (const [jid, group] of Object.entries(groups)) {
        try {
          await global.botSocket.groupRequestParticipantsList(jid);
          approved++;
        } catch (e) {}
      }
      res.json({ success: true, message: `Processed ${approved} groups` });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  } else {
    res.json({ success: false, message: "Bot not connected" });
  }
});

// ─── Dashboard-driven pairing ────────────────────────────────
// Step 1: Dashboard POSTs phone number → we store it and (re)start bot
app.post("/api/pair", async (req, res) => {
  const phone = (req.body.phone || "").replace(/\D/g, "");
  if (!phone || phone.length < 7) {
    return res.json({ success: false, message: "Invalid phone number" });
  }
  // If already connected, don't re-pair
  if (global.botConnected) {
    return res.json({ success: false, message: "Bot already connected" });
  }
  global.pendingPhone = phone;
  clearSession();
  isConnecting = false;
  // Small delay then restart
  setTimeout(() => startBot(), 500);
  res.json({ success: true, message: "Pairing started — code will appear shortly" });
});

// Step 2: Dashboard polls this to get the code once generated
app.get("/api/pair-status", (req, res) => {
  res.json({
    connected  : !!global.botConnected,
    pairingCode: global.lastPairingCode || null,
    phone      : global.pendingPhone    || null,
  });
});

// ─── Strike System ───────────────────────────────────────────
function addStrike(jid, reason) {
  if (!strikes[jid]) strikes[jid] = { count: 0, reasons: [] };
  strikes[jid].count++;
  strikes[jid].reasons.push({ reason, time: new Date().toISOString() });
  saveJSON(STRIKES_FILE, strikes);
  return strikes[jid].count;
}

function resetStrikes(jid) {
  delete strikes[jid];
  saveJSON(STRIKES_FILE, strikes);
}

// ─── Activity Tracker ────────────────────────────────────────
function logActivity(jid, groupJid, type) {
  if (!config.features.activityTracker) return;
  const week = getWeekKey();
  if (!activity[week]) activity[week] = {};
  if (!activity[week][groupJid]) activity[week][groupJid] = {};
  if (!activity[week][groupJid][jid]) activity[week][groupJid][jid] = { messages: 0, media: 0, commands: 0 };
  activity[week][groupJid][jid][type] = (activity[week][groupJid][jid][type] || 0) + 1;
  saveJSON(ACTIVITY_FILE, activity);
}

function getWeekKey() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${week}`;
}

// ─── Auto Vanish ─────────────────────────────────────────────
function scheduleVanish(sock, key) {
  vanishQueue.push({ key, deleteAt: Date.now() + 30 * 60 * 1000 });
}

async function processVanishQueue(sock) {
  const now = Date.now();
  const toDelete = vanishQueue.filter((v) => now >= v.deleteAt);
  for (const item of toDelete) {
    try {
      await sock.sendMessage(item.key.remoteJid, { delete: item.key });
    } catch (e) {}
    vanishQueue.splice(vanishQueue.indexOf(item), 1);
  }
}

// ─── Number Helpers ──────────────────────────────────────────
function isSriLankan(jid) {
  const num = jid.replace("@s.whatsapp.net", "");
  return num.startsWith("94") || num.startsWith("+94");
}

function isAdmin(jid, groupMetadata) {
  const admins = (groupMetadata?.participants || [])
    .filter((p) => p.admin === "admin" || p.admin === "superadmin")
    .map((p) => p.id);
  const adminNum = (config.ADMIN_NUMBER || "").replace(/\D/g, "");
  return admins.includes(jid) || jid.includes(adminNum);
}

// ─── Phone prompt helper (reads one line from stdin) ─────────
function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// ─── Clean session dir so stale creds don't block pairing ────
function clearSession() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.readdirSync(SESSION_DIR).forEach((f) => fs.rmSync(path.join(SESSION_DIR, f), { force: true }));
    }
  } catch (e) { /* ignore */ }
}

// ─── Main Bot Logic ──────────────────────────────────────────
let reconnectTimer = null;
let isConnecting   = false;

async function startBot() {
  // Prevent overlapping reconnect attempts
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    // ── Build socket (NO printQRInTerminal — pairing code only) ──
    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys : makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal        : false,   // ← must be false for pairing code
      syncFullHistory          : false,
      markOnlineOnConnect      : true,
      generateHighQualityLinkPreview: false,
      // Browser fingerprint that WA accepts for pairing-code devices
      browser                  : ["SP MD BOT", "Chrome", "120.0.0"],
      connectTimeoutMs         : 60_000,
      keepAliveIntervalMs      : 25_000,
      retryRequestDelayMs      : 2_000,
    });

    global.botSocket = sock;

    // ── Pairing Code Login (only when not yet registered) ────
    if (!state.creds.registered) {
      // Priority: dashboard input → env var → wait (dashboard will POST /api/pair)
      let phone = global.pendingPhone
        || (process.env.PHONE_NUMBER || "").replace(/\D/g, "");

      if (!phone) {
        // No phone yet — tell dashboard we're waiting, don't crash
        console.log("⏳ Waiting for phone number from dashboard (/api/pair)…");
        io.emit("bot_status", { connected: false, waitingForPhone: true });
        isConnecting = false;
        return; // startBot() will be called again when /api/pair is hit
      }

      global.pendingPhone    = phone; // keep it set for reconnects
      global.lastPairingCode = null;
      global.botConnected    = false;

      let pairingDone = false;

      sock.ev.on("connection.update", async ({ connection, qr }) => {
        if ((qr || connection === "connecting") && !pairingDone) {
          pairingDone = true;
          try {
            await new Promise((r) => setTimeout(r, 1500));
            const code      = await sock.requestPairingCode(phone);
            const formatted = code.match(/.{1,4}/g)?.join("-") ?? code;

            global.lastPairingCode = formatted;

            console.log("\n╔═══════════════════════════════════════╗");
            console.log(`║   🔑  PAIRING CODE: ${formatted.padEnd(18)}║`);
            console.log("╠═══════════════════════════════════════╣");
            console.log("║  WhatsApp → Linked Devices            ║");
            console.log("║  → Link a Device → Link with          ║");
            console.log("║    phone number → Enter code above    ║");
            console.log("╚═══════════════════════════════════════╝\n");

            io.emit("pairing_code", { code: formatted, phone });

          } catch (err) {
            console.error("❌ Pairing code request failed:", err.message);
            io.emit("pairing_error", { message: err.message });
            setTimeout(() => { clearSession(); isConnecting = false; startBot(); }, 10_000);
          }
        }
      });
    }

    // ── Connection lifecycle ──────────────────────────────────
    sock.ev.on("connection.update", ({ connection, lastDisconnect, isNewLogin }) => {
      if (connection === "open") {
        isConnecting        = false;
        global.botConnected = true;
        global.lastPairingCode = null; // clear code once connected
        const botNum  = sock.user?.id?.split(":")[0] ?? "unknown";
        console.log(`\n✅ SP MD BOT connected as +${botNum}\n`);
        io.emit("bot_status", { connected: true, number: botNum });
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      }

      if (connection === "close") {
        isConnecting        = false;
        global.botConnected = false;
        const errCode = lastDisconnect?.error?.output?.statusCode;
        const reason  = lastDisconnect?.error?.message ?? "unknown";

        console.log(`🔴 Connection closed — code: ${errCode} | reason: ${reason}`);
        io.emit("bot_status", { connected: false });

        if (errCode === DisconnectReason.loggedOut) {
          // Session revoked from phone — wipe and re-pair
          console.log("⚠️  Session logged out. Clearing session for fresh pairing…");
          clearSession();
          reconnectTimer = setTimeout(() => { isConnecting = false; startBot(); }, 3_000);

        } else if (errCode === DisconnectReason.badSession) {
          console.log("⚠️  Bad/corrupt session. Clearing and restarting…");
          clearSession();
          reconnectTimer = setTimeout(() => { isConnecting = false; startBot(); }, 3_000);

        } else if (errCode === DisconnectReason.connectionReplaced) {
          console.log("⚠️  Another session opened. Bot stopping.");
          // Don't reconnect — another device took over

        } else if (errCode === DisconnectReason.timedOut) {
          console.log("⏱  Connection timed out. Reconnecting in 5 s…");
          reconnectTimer = setTimeout(() => { isConnecting = false; startBot(); }, 5_000);

        } else {
          // Generic disconnect — exponential-ish backoff
          const delay = [401, 403, 500, 515].includes(errCode) ? 15_000 : 5_000;
          console.log(`🔄 Reconnecting in ${delay / 1000} s…`);
          reconnectTimer = setTimeout(() => { isConnecting = false; startBot(); }, delay);
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

    // ── Vanish Queue Interval ─────────────────────────────────
    setInterval(() => processVanishQueue(sock), 60_000);

    // ── Silent Hours Cron ─────────────────────────────────────
    cron.schedule("0 * * * *", async () => {
      if (!config.features.silentHours) return;
      const hour = new Date().getHours();
      const { silentHoursStart: start, silentHoursEnd: end } = config;
      const isSilent = start > end ? hour >= start || hour < end : hour >= start && hour < end;
      const groups = await sock.groupFetchAllParticipating().catch(() => ({}));
      for (const jid of Object.keys(groups)) {
        try {
          await sock.groupSettingUpdate(jid, isSilent ? "announcement" : "not_announcement");
          if (isSilent) {
            const msg = await sock.sendMessage(jid, { text: "🌙 *Silent Hours Active* — Group is locked until morning. Sleep well! 😴" });
            scheduleVanish(sock, msg.key);
          }
        } catch (e) {}
      }
    });

    // ── Smart Marketing Cron ──────────────────────────────────
    cron.schedule("0 * * * *", async () => {
      if (!config.features.smartMarketing || !config.LANDING_PAGE_URL) return;
      const hour = new Date().getHours();
      const { marketingHoursStart: mStart, marketingHoursEnd: mEnd } = config;
      if (hour < mStart || hour >= mEnd) return;
      const caption = await geminiChat(
        `Write a short, enticing, natural-sounding WhatsApp message (2-3 lines max) to promote this link: ${config.LANDING_PAGE_URL}. No hashtags. Sinhala or English.`
      );
      if (!caption) return;
      const groups = await sock.groupFetchAllParticipating().catch(() => ({}));
      for (const jid of Object.keys(groups)) {
        try {
          const msg = await sock.sendMessage(jid, { text: `${caption}\n\n🔗 ${config.LANDING_PAGE_URL}` });
          scheduleVanish(sock, msg.key);
        } catch (e) {}
      }
    });

    // ── Weekly Activity Report Cron ───────────────────────────
    cron.schedule("0 9 * * 1", async () => {
      if (!config.features.activityTracker) return;
      const week = getWeekKey();
      const data = activity[week] || {};
      const adminJid = `${(config.ADMIN_NUMBER || "").replace(/\D/g, "")}@s.whatsapp.net`;
      for (const [groupJid, members] of Object.entries(data)) {
        const sorted = Object.entries(members)
          .sort((a, b) => (b[1].messages || 0) - (a[1].messages || 0))
          .slice(0, 10);
        const report = sorted.map(([jid, stats], i) =>
          `${i + 1}. @${jid.split("@")[0]} — 💬${stats.messages || 0} 📷${stats.media || 0} ⚡${stats.commands || 0}`
        ).join("\n");
        try {
          await sock.sendMessage(adminJid, { text: `📊 *Weekly Activity Report*\n\n${report}` });
        } catch (e) {}
      }
    });

    // ── Call Protection ───────────────────────────────────────
    sock.ev.on("call", async (calls) => {
      if (!config.features.antiCall) return;
      for (const call of calls) {
        if (call.status === "offer") {
          try {
            await sock.rejectCall(call.id, call.from);
            await sock.sendMessage(call.from, { text: "⛔ Calls are not allowed in this group. Your call was rejected automatically." });
          } catch (e) {}
        }
      }
    });

    // ── Message Handler ───────────────────────────────────────
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        try {
          await handleMessage(sock, msg);
        } catch (e) {
          console.error("Message handler error:", e.message);
        }
      }
    });

    // ── Group Join Requests ───────────────────────────────────
    sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
      if (action === "add" && config.features.activityTracker) {
        for (const p of participants) logActivity(p, id, "messages");
      }
    });

  } catch (err) {
    isConnecting = false;
    console.error("Fatal startBot error:", err.message);
    console.log("🔄 Restarting in 8 s…");
    setTimeout(() => startBot(), 8_000);
  }
}

// ─── Message Handler ─────────────────────────────────────────
async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;
  const isGroup = jid?.endsWith("@g.us");
  const sender = isGroup ? msg.key.participant : jid;
  const senderNum = sender?.replace("@s.whatsapp.net", "");

  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    "";

  const msgType = Object.keys(msg.message || {})[0];

  // ── Group Metadata ────────────────────────────────────────
  let groupMeta = null;
  if (isGroup) {
    try { groupMeta = await sock.groupMetadata(jid); } catch (e) {}
  }

  const senderIsAdmin = isGroup ? isAdmin(sender, groupMeta) : true;

  // ── Log Activity ──────────────────────────────────────────
  if (isGroup) {
    const actType = ["imageMessage", "videoMessage", "audioMessage"].includes(msgType) ? "media" : "messages";
    logActivity(sender, jid, actType);
    io.emit("activity_update", { sender, jid, type: actType });
  }

  // ── Image Moderation (Gemini Vision) ─────────────────────
  if (
    config.features.imageModeration &&
    isGroup &&
    !senderIsAdmin &&
    (msgType === "imageMessage")
  ) {
    try {
      const stream = await downloadContentFromMessage(msg.message.imageMessage, "image");
      let buffer = Buffer.alloc(0);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      const base64 = buffer.toString("base64");
      const check = await geminiVisionCheck(base64, msg.message.imageMessage.mimetype || "image/jpeg");

      if (check?.explicit && check.confidence > 70) {
        await sock.sendMessage(jid, { delete: msg.key });
        const strikeCount = addStrike(sender, "Explicit image");
        const warn = await sock.sendMessage(jid, {
          text: `🚫 @${senderNum} Explicit content detected and removed.\n⚠️ Strike ${strikeCount}/3`,
          mentions: [sender],
        });
        scheduleVanish(sock, warn.key);
        if (strikeCount >= 3) {
          await sock.groupParticipantsUpdate(jid, [sender], "remove");
          resetStrikes(sender);
        }
        io.emit("moderation_event", { type: "explicit_image", sender, jid, reason: check.reason });
        return;
      }
    } catch (e) { console.error("Image mod error:", e.message); }
  }

  // ── Link Ban ──────────────────────────────────────────────
  if (config.features.linkBan && isGroup && !senderIsAdmin) {
    const linkRegex = /https?:\/\/[^\s]+/gi;
    if (linkRegex.test(body)) {
      await sock.sendMessage(jid, { delete: msg.key });
      const strikeCount = addStrike(sender, "Link posted");
      const warn = await sock.sendMessage(jid, {
        text: `🔗 @${senderNum} Links are not allowed! Strike ${strikeCount}/3.`,
        mentions: [sender],
      });
      scheduleVanish(sock, warn.key);
      if (strikeCount >= 3) {
        await sock.groupParticipantsUpdate(jid, [sender], "remove");
        resetStrikes(sender);
      }
      return;
    }
  }

  // ── Anti-Foreign Number ───────────────────────────────────
  if (config.features.antiForeign && isGroup && !senderIsAdmin && !isSriLankan(sender)) {
    if (body.length > 5) {
      await sock.groupParticipantsUpdate(jid, [sender], "remove");
      const note = await sock.sendMessage(jid, { text: `🌏 Non-Sri Lankan number removed for spam protection.` });
      scheduleVanish(sock, note.key);
      return;
    }
  }

  // ── Fake News Detector ────────────────────────────────────
  if (config.features.fakeNewsDetector && isGroup && body.length > 20) {
    const urlMatch = body.match(/https?:\/\/[^\s]+/);
    if (urlMatch && senderIsAdmin) {
      const analysis = await geminiFakeNews(urlMatch[0]);
      if (analysis?.suspicious && analysis.confidence > 70) {
        const warn = await sock.sendMessage(jid, {
          text: `🚨 *Fake News Alert*\nVerdict: ${analysis.verdict}\nReason: ${analysis.reason}\nConfidence: ${analysis.confidence}%`,
        });
        scheduleVanish(sock, warn.key);
      }
    }
  }

  // ── Auto Translate ────────────────────────────────────────
  if (config.features.autoTranslate && isGroup && body.length > 10) {
    const nonLatin = /[^\u0000-\u007F\u0D80-\u0DFF\s]/;
    if (nonLatin.test(body)) {
      const translated = await geminiTranslate(body);
      if (translated && translated !== body) {
        const note = await sock.sendMessage(jid, {
          text: `🌐 *Auto-translate:*\n${translated}`,
          quoted: msg,
        });
        scheduleVanish(sock, note.key);
      }
    }
  }

  // ── Command Prefix ────────────────────────────────────────
  if (!body.startsWith(".")) return;

  const [cmd, ...args] = body.slice(1).split(" ");
  const text = args.join(" ");

  logActivity(sender, jid || sender, "commands");

  // ── Admin Commands (Private Only) ─────────────────────────
  if (!isGroup) {
    if (cmd === "update_advice" && text) {
      const advice = loadJSON(ADVICE_FILE, {});
      advice.advice = text;
      advice.lastUpdated = new Date().toISOString();
      advice.updatedBy = senderNum;
      saveJSON(ADVICE_FILE, advice);
      await sock.sendMessage(jid, { text: "✅ Bot advice updated successfully!" });
      io.emit("advice_updated", advice);
      return;
    }
  }

  switch (cmd.toLowerCase()) {
    // ── AI Chat ─────────────────────────────────────────────
    case "ai":
    case "ask": {
      if (!text) return sock.sendMessage(jid, { text: "Usage: .ai [your question]", quoted: msg });
      const reply = await geminiChat(text);
      if (reply) {
        const r = await sock.sendMessage(jid, { text: reply, quoted: msg });
        if (isGroup) scheduleVanish(sock, r.key);
      }
      break;
    }

    // ── Draw / Image Generation ───────────────────────────
    case "draw": {
      if (!config.features.imageGeneration) break;
      if (!text) return sock.sendMessage(jid, { text: "Usage: .draw [prompt]", quoted: msg });
      const result = await geminiGenerateImage(text);
      if (result?.imageUrl) {
        try {
          const imgRes = await axios.get(result.imageUrl, { responseType: "arraybuffer", timeout: 15000 });
          const r = await sock.sendMessage(jid, {
            image: Buffer.from(imgRes.data),
            caption: `🎨 *${text}*\n\n${result.description?.slice(0, 200) || ""}`,
            quoted: msg,
          });
          if (isGroup) scheduleVanish(sock, r.key);
        } catch (e) {
          await sock.sendMessage(jid, { text: `🎨 Image: ${result.imageUrl}`, quoted: msg });
        }
      }
      break;
    }

    // ── YouTube Download ──────────────────────────────────
    case "ytmp3":
    case "ytmp4": {
      if (!config.features.ytDownloader) break;
      if (!text) return sock.sendMessage(jid, { text: `Usage: .${cmd} [YouTube URL]`, quoted: msg });
      const r = await sock.sendMessage(jid, {
        text: `⏳ Processing YouTube ${cmd === "ytmp3" ? "audio" : "video"}...\n🔗 ${text}`,
        quoted: msg,
      });
      if (isGroup) scheduleVanish(sock, r.key);
      // Note: ytdl-core requires active maintenance; for production use yt-dlp binary
      await sock.sendMessage(jid, {
        text: `⚠️ YouTube download requires yt-dlp installed on server.\nURL: ${text}\nFormat: ${cmd === "ytmp3" ? "MP3" : "MP4"}`,
        quoted: msg,
      });
      break;
    }

    // ── Request System ────────────────────────────────────
    case "request": {
      if (!config.features.requestSystem) break;
      if (!text) return sock.sendMessage(jid, { text: "Usage: .request [your message]", quoted: msg });
      const adminJid = `${(config.ADMIN_NUMBER || "").replace(/\D/g, "")}@s.whatsapp.net`;
      const groupName = groupMeta?.subject || jid;
      await sock.sendMessage(adminJid, {
        text: `📩 *New Request*\nFrom: @${senderNum}\nGroup: ${groupName}\n\n${text}`,
      });
      const confirm = await sock.sendMessage(jid, { text: "✅ Your request has been sent to admin.", quoted: msg });
      scheduleVanish(sock, confirm.key);
      break;
    }

    // ── Video to Sticker ──────────────────────────────────
    case "sticker":
    case "s": {
      if (!config.features.videoSticker) break;
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quoted?.videoMessage && !quoted?.imageMessage) {
        return sock.sendMessage(jid, { text: "Reply to an image or short video with .sticker", quoted: msg });
      }
      const mediaType = quoted.videoMessage ? "video" : "image";
      const mediaMsg = quoted.videoMessage || quoted.imageMessage;
      try {
        const stream = await downloadContentFromMessage(mediaMsg, mediaType);
        let buffer = Buffer.alloc(0);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        const r = await sock.sendMessage(jid, { sticker: buffer, quoted: msg });
        if (isGroup) scheduleVanish(sock, r.key);
      } catch (e) {
        await sock.sendMessage(jid, { text: "❌ Could not create sticker. Try a shorter clip.", quoted: msg });
      }
      break;
    }

    // ── Strike Check ──────────────────────────────────────
    case "strikes": {
      if (!senderIsAdmin && isGroup) break;
      const target = msg.message?.extendedTextMessage?.contextInfo?.participant || sender;
      const s = strikes[target];
      await sock.sendMessage(jid, {
        text: s
          ? `⚠️ @${target.split("@")[0]} has ${s.count} strike(s).\nReasons: ${s.reasons.map((r) => r.reason).join(", ")}`
          : `✅ @${target.split("@")[0]} has no strikes.`,
        mentions: [target],
        quoted: msg,
      });
      break;
    }

    // ── Reset Strikes (Admin) ─────────────────────────────
    case "resetstrike": {
      if (!senderIsAdmin) break;
      const target = msg.message?.extendedTextMessage?.contextInfo?.participant;
      if (target) {
        resetStrikes(target);
        await sock.sendMessage(jid, { text: `✅ Strikes reset for @${target.split("@")[0]}`, mentions: [target], quoted: msg });
      }
      break;
    }

    // ── Fake News Check ───────────────────────────────────
    case "check": {
      if (!config.features.fakeNewsDetector || !text) break;
      const analysis = await geminiFakeNews(text);
      if (analysis) {
        const r = await sock.sendMessage(jid, {
          text: `🔍 *Fact Check Result*\n\n📌 Verdict: *${analysis.verdict}*\n⚡ Confidence: ${analysis.confidence}%\n📝 Reason: ${analysis.reason}`,
          quoted: msg,
        });
        if (isGroup) scheduleVanish(sock, r.key);
      }
      break;
    }

    // ── Help ──────────────────────────────────────────────
    case "help":
    case "menu": {
      const help = `🤖 *SP MD BOT — Commands*\n
📌 *General*
• .ai [question] — Ask Gemini AI
• .draw [prompt] — Generate AI image
• .request [text] — Send message to admin
• .check [url/claim] — Fake news detector
• .sticker — Convert media to sticker

🎵 *Media*
• .ytmp3 [url] — YouTube to MP3
• .ytmp4 [url] — YouTube to MP4

🛡️ *Admin*
• .strikes — Check user strikes
• .resetstrike — Reset strikes
• .update_advice [text] — Update bot advice (DM only)

⚙️ Manage settings: Dashboard`;
      const r = await sock.sendMessage(jid, { text: help, quoted: msg });
      if (isGroup) scheduleVanish(sock, r.key);
      break;
    }
  }
}

// ─── Start Everything ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║    SP MD BOT — Dashboard Ready       ║`);
  console.log(`║    http://localhost:${PORT}              ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

startBot().catch(console.error);
