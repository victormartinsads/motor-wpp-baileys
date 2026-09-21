import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import qrcode from "qrcode";
import pino from "pino";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const AUTH_DIR = path.join(__dirname, "baileys_auth_info");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const STORE_FILE = path.join(__dirname, "store.json");

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Memory + persistent store setup
let storeData = {
  chats: {},
  messages: {},
  groupConfig: {
    activeGroupJid: "",
    groupName: "",
    updatedAt: null,
  },
};

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, "utf-8");
      storeData = JSON.parse(raw);
    }
  } catch (err) {
    console.error("[Store] Failed to load store.json:", err);
  }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(storeData, null, 2), "utf-8");
  } catch (err) {
    console.error("[Store] Failed to save store.json:", err);
  }
}

loadStore();

// Setup Multer for media uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || ".bin";
    cb(null, file.fieldname + "-" + uniqueSuffix + ext);
  },
});
const upload = multer({ storage });

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Static media serve route
app.use("/api/whatsapp/media", express.static(UPLOADS_DIR));

let sock = null;
let connectionState = {
  status: "DISCONNECTED", // CONNECTED | SCAN_QR | DISCONNECTED | CONNECTING
  qrCodeBase64: null,
  user: null,
  phone: null,
  battery: 100,
};

const logger = pino({ level: "silent" });

async function initWhatsAppSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  connectionState.status = "CONNECTING";

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState.status = "SCAN_QR";
      try {
        connectionState.qrCodeBase64 = await qrcode.toDataURL(qr);
      } catch (err) {
        console.error("QR Code generation error:", err);
      }
    }

    if (connection === "open") {
      connectionState.status = "CONNECTED";
      connectionState.qrCodeBase64 = null;

      const userJid = sock.user?.id || "";
      const phone = userJid.split(":")[0] || userJid.split("@")[0];
      const name = sock.user?.name || sock.user?.verifiedName || "Central AND Manager";

      connectionState.user = { name, phone, jid: userJid };
      connectionState.phone = phone;

      console.log(`[Baileys] Connected as ${name} (${phone})`);
    } else if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[Baileys] Connection closed. StatusCode: ${statusCode}. Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        connectionState.status = "CONNECTING";
        setTimeout(() => initWhatsAppSocket(), 3000);
      } else {
        connectionState.status = "DISCONNECTED";
        connectionState.qrCodeBase64 = null;
        connectionState.user = null;
        connectionState.phone = null;

        // Clean auth dir on logout
        try {
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
        } catch (e) {
          console.error("Error clearing auth dir:", e);
        }
      }
    }
  });

  // Handle incoming & outgoing messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid === "status@broadcast") continue;

      const fromMe = msg.key.fromMe || false;
      const isGroup = jid.endsWith("@g.us");
      const pushName = msg.pushName || (fromMe ? "Você" : jid.split("@")[0]);

      let textContent =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        "";

      let contentType = "text";
      let mediaFilename = null;

      if (msg.message.imageMessage) {
        contentType = "image";
      } else if (msg.message.videoMessage) {
        contentType = "video";
      } else if (msg.message.audioMessage) {
        contentType = "audio";
      } else if (msg.message.documentMessage) {
        contentType = "document";
        textContent = textContent || msg.message.documentMessage.fileName || "Documento PDF";
      }

      // Download media if present
      if (["image", "video", "audio", "document"].includes(contentType)) {
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger });
          const ext =
            contentType === "image"
              ? ".jpg"
              : contentType === "video"
              ? ".mp4"
              : contentType === "audio"
              ? ".ogg"
              : ".pdf";
          mediaFilename = `media_${Date.now()}_${Math.round(Math.random() * 10000)}${ext}`;
          fs.writeFileSync(path.join(UPLOADS_DIR, mediaFilename), buffer);
        } catch (err) {
          console.error("[Media Download Error]:", err);
        }
      }

      const timestamp = (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now());

      const msgObj = {
        id: msg.key.id,
        chatId: jid,
        fromMe,
        senderName: pushName,
        senderJid: msg.key.participant || jid,
        type: contentType,
        text: textContent,
        mediaUrl: mediaFilename ? `/api/whatsapp/media/${mediaFilename}` : null,
        timestamp,
        status: "delivered",
      };

      // Store message
      if (!storeData.messages[jid]) {
        storeData.messages[jid] = [];
      }

      // Avoid duplicates
      const exists = storeData.messages[jid].some((m) => m.id === msg.key.id);
      if (!exists) {
        storeData.messages[jid].push(msgObj);
      }

      // Update chat entry
      storeData.chats[jid] = {
        id: jid,
        name: storeData.chats[jid]?.name || (isGroup ? `Grupo (${jid.split("@")[0]})` : pushName),
        phone: jid.split("@")[0],
        isGroup,
        lastMessageText: textContent || `[${contentType.toUpperCase()}]`,
        lastMessageTime: timestamp,
        unreadCount: (storeData.chats[jid]?.unreadCount || 0) + (fromMe ? 0 : 1),
        avatarUrl: storeData.chats[jid]?.avatarUrl || null,
      };

      saveStore();
    }
  });

  // Handle group metadata updates
  sock.ev.on("groups.update", (groups) => {
    for (const group of groups) {
      if (storeData.chats[group.id]) {
        storeData.chats[group.id].name = group.subject || storeData.chats[group.id].name;
      }
    }
    saveStore();
  });
}

// Start WhatsApp Connection on Server Start
initWhatsAppSocket();

// Helper to format JID
function formatJid(inputPhoneOrJid, isGroup = false) {
  if (!inputPhoneOrJid) return "";
  if (inputPhoneOrJid.includes("@")) return inputPhoneOrJid;
  const cleanNumber = inputPhoneOrJid.replace(/\D/g, "");
  if (isGroup || cleanNumber.length > 15) {
    return `${cleanNumber}@g.us`;
  }
  return `${cleanNumber}@s.whatsapp.net`;
}

// -------------------------------------------------------------
// REST API ENDPOINTS
// -------------------------------------------------------------

// 1. GET /api/whatsapp/session
app.get("/api/whatsapp/session", (req, res) => {
  return res.json({
    status: connectionState.status,
    qrCode: connectionState.qrCodeBase64,
    user: connectionState.user,
    phone: connectionState.phone,
    battery: connectionState.battery,
    groupConfig: storeData.groupConfig,
  });
});

// 2. POST /api/whatsapp/connect-qr
app.post("/api/whatsapp/connect-qr", async (req, res) => {
  if (connectionState.status === "CONNECTED") {
    return res.json({
      status: "CONNECTED",
      message: "WhatsApp já está conectado.",
      user: connectionState.user,
    });
  }

  if (!sock || connectionState.status === "DISCONNECTED") {
    await initWhatsAppSocket();
  }

  return res.json({
    status: connectionState.status,
    qrCode: connectionState.qrCodeBase64,
  });
});

// 3. POST /api/whatsapp/disconnect
app.post("/api/whatsapp/disconnect", async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
  } catch (err) {
    console.error("Logout error:", err);
  }

  connectionState.status = "DISCONNECTED";
  connectionState.qrCodeBase64 = null;
  connectionState.user = null;

  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    console.error("Error clearing auth dir:", e);
  }

  return res.json({ success: true, message: "Sessão encerrada com sucesso." });
});

// 4. GET /api/whatsapp/chats
app.get("/api/whatsapp/chats", async (req, res) => {
  const chatList = Object.values(storeData.chats).sort(
    (a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0)
  );

  return res.json({ success: true, chats: chatList });
});

// 5. GET /api/whatsapp/groups
app.get("/api/whatsapp/groups", async (req, res) => {
  try {
    let groups = [];
    if (sock && connectionState.status === "CONNECTED") {
      const groupMap = await sock.groupFetchAllParticipating();
      groups = Object.values(groupMap).map((g) => ({
        id: g.id,
        name: g.subject,
        owner: g.owner,
        creation: g.creation,
        participantsCount: g.participants?.length || 0,
      }));

      // Update store with fetched groups
      for (const g of groups) {
        storeData.chats[g.id] = {
          id: g.id,
          name: g.name,
          phone: g.id.split("@")[0],
          isGroup: true,
          lastMessageText: storeData.chats[g.id]?.lastMessageText || "Grupo WhatsApp",
          lastMessageTime: storeData.chats[g.id]?.lastMessageTime || Date.now(),
          unreadCount: storeData.chats[g.id]?.unreadCount || 0,
        };
      }
      saveStore();
    } else {
      // Return cached groups from store
      groups = Object.values(storeData.chats)
        .filter((c) => c.isGroup)
        .map((c) => ({
          id: c.id,
          name: c.name,
          participantsCount: 0,
        }));
    }

    return res.json({ success: true, groups });
  } catch (err) {
    console.error("Failed to fetch groups:", err);
    return res.status(500).json({ error: "Falha ao buscar grupos: " + err.message });
  }
});

// 6. POST /api/whatsapp/groups/config
app.post("/api/whatsapp/groups/config", (req, res) => {
  const { groupJid, groupName } = req.body;
  if (!groupJid) {
    return res.status(400).json({ error: "groupJid é obrigatório." });
  }

  storeData.groupConfig = {
    activeGroupJid: groupJid,
    groupName: groupName || storeData.chats[groupJid]?.name || groupJid,
    updatedAt: new Date().toISOString(),
  };

  saveStore();

  return res.json({ success: true, groupConfig: storeData.groupConfig });
});

// 7. GET /api/whatsapp/messages
app.get("/api/whatsapp/messages", (req, res) => {
  const { chatId } = req.query;
  if (!chatId) {
    return res.status(400).json({ error: "chatId query parameter required" });
  }

  const formattedId = formatJid(String(chatId), String(chatId).includes("@g.us"));
  const messages = storeData.messages[formattedId] || storeData.messages[String(chatId)] || [];

  // Reset unread count for this chat
  if (storeData.chats[formattedId]) {
    storeData.chats[formattedId].unreadCount = 0;
    saveStore();
  }

  return res.json({ success: true, chatId: formattedId, messages });
});

// 8. POST /api/whatsapp/send-message
app.post("/api/whatsapp/send-message", async (req, res) => {
  const { phone, text, isGroup } = req.body;

  if (!phone || !text) {
    return res.status(400).json({ error: "phone/jid e text são obrigatórios" });
  }

  if (connectionState.status !== "CONNECTED" || !sock) {
    return res.status(400).json({ error: "WhatsApp não está conectado" });
  }

  try {
    const jid = formatJid(phone, isGroup || phone.endsWith("@g.us"));
    const sentMsg = await sock.sendMessage(jid, { text });

    const timestamp = Date.now();
    const msgObj = {
      id: sentMsg.key.id,
      chatId: jid,
      fromMe: true,
      senderName: "Você",
      senderJid: sock.user?.id,
      type: "text",
      text,
      mediaUrl: null,
      timestamp,
      status: "sent",
    };

    if (!storeData.messages[jid]) {
      storeData.messages[jid] = [];
    }
    storeData.messages[jid].push(msgObj);

    storeData.chats[jid] = {
      id: jid,
      name: storeData.chats[jid]?.name || (isGroup ? `Grupo (${jid.split("@")[0]})` : jid.split("@")[0]),
      phone: jid.split("@")[0],
      isGroup: jid.endsWith("@g.us"),
      lastMessageText: text,
      lastMessageTime: timestamp,
      unreadCount: 0,
    };

    saveStore();

    return res.json({ success: true, messageId: sentMsg.key.id, jid });
  } catch (err) {
    console.error("send-message error:", err);
    return res.status(500).json({ error: "Falha ao enviar mensagem: " + err.message });
  }
});

// 9. POST /api/whatsapp/send-audio
app.post("/api/whatsapp/send-audio", async (req, res) => {
  const { phone, audioBase64, isGroup } = req.body;

  if (!phone || !audioBase64) {
    return res.status(400).json({ error: "phone e audioBase64 são obrigatórios" });
  }

  if (connectionState.status !== "CONNECTED" || !sock) {
    return res.status(400).json({ error: "WhatsApp não está conectado" });
  }

  try {
    const jid = formatJid(phone, isGroup || phone.endsWith("@g.us"));
    const cleanBase64 = audioBase64.replace(/^data:audio\/\w+;base64,/, "");
    const buffer = Buffer.from(cleanBase64, "base64");

    const sentMsg = await sock.sendMessage(jid, {
      audio: buffer,
      mimetype: "audio/mp4",
      ptt: true,
    });

    const timestamp = Date.now();
    const mediaFilename = `audio_${Date.now()}_${Math.round(Math.random() * 1000)}.mp4`;
    fs.writeFileSync(path.join(UPLOADS_DIR, mediaFilename), buffer);

    const msgObj = {
      id: sentMsg.key.id,
      chatId: jid,
      fromMe: true,
      senderName: "Você",
      senderJid: sock.user?.id,
      type: "audio",
      text: "[Nota de Voz]",
      mediaUrl: `/api/whatsapp/media/${mediaFilename}`,
      timestamp,
      status: "sent",
    };

    if (!storeData.messages[jid]) {
      storeData.messages[jid] = [];
    }
    storeData.messages[jid].push(msgObj);

    storeData.chats[jid] = {
      id: jid,
      name: storeData.chats[jid]?.name || jid.split("@")[0],
      phone: jid.split("@")[0],
      isGroup: jid.endsWith("@g.us"),
      lastMessageText: "[ÁUDIO]",
      lastMessageTime: timestamp,
      unreadCount: 0,
    };

    saveStore();

    return res.json({ success: true, messageId: sentMsg.key.id, jid });
  } catch (err) {
    console.error("send-audio error:", err);
    return res.status(500).json({ error: "Falha ao enviar áudio: " + err.message });
  }
});

// 10. POST /api/whatsapp/send-media (Multipart Upload)
app.post("/api/whatsapp/send-media", upload.single("file"), async (req, res) => {
  const { phone, caption, type, isGroup } = req.body;
  const file = req.file;

  if (!phone || !file) {
    return res.status(400).json({ error: "phone e arquivo de mídia são obrigatórios" });
  }

  if (connectionState.status !== "CONNECTED" || !sock) {
    return res.status(400).json({ error: "WhatsApp não está conectado" });
  }

  try {
    const jid = formatJid(phone, isGroup === "true" || phone.endsWith("@g.us"));
    const buffer = fs.readFileSync(file.path);
    const mediaType = type || (file.mimetype.startsWith("image/") ? "image" : file.mimetype.startsWith("video/") ? "video" : "document");

    let messagePayload = {};

    if (mediaType === "image") {
      messagePayload = { image: buffer, caption: caption || "" };
    } else if (mediaType === "video") {
      messagePayload = { video: buffer, caption: caption || "" };
    } else {
      messagePayload = {
        document: buffer,
        mimetype: file.mimetype || "application/pdf",
        fileName: file.originalname,
        caption: caption || "",
      };
    }

    const sentMsg = await sock.sendMessage(jid, messagePayload);

    const timestamp = Date.now();
    const mediaUrl = `/api/whatsapp/media/${path.basename(file.path)}`;

    const msgObj = {
      id: sentMsg.key.id,
      chatId: jid,
      fromMe: true,
      senderName: "Você",
      senderJid: sock.user?.id,
      type: mediaType,
      text: caption || file.originalname,
      mediaUrl,
      timestamp,
      status: "sent",
    };

    if (!storeData.messages[jid]) {
      storeData.messages[jid] = [];
    }
    storeData.messages[jid].push(msgObj);

    storeData.chats[jid] = {
      id: jid,
      name: storeData.chats[jid]?.name || jid.split("@")[0],
      phone: jid.split("@")[0],
      isGroup: jid.endsWith("@g.us"),
      lastMessageText: `[${mediaType.toUpperCase()}] ${caption || ""}`,
      lastMessageTime: timestamp,
      unreadCount: 0,
    };

    saveStore();

    return res.json({ success: true, messageId: sentMsg.key.id, mediaUrl });
  } catch (err) {
    console.error("send-media error:", err);
    return res.status(500).json({ error: "Falha ao enviar mídia: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[WhatsApp Server] Running on http://localhost:${PORT}`);
});
