const express  = require("express");
const os       = require("os");
const fs       = require("fs");
const path     = require("path");
const multer   = require("multer");
const sharp    = require("sharp");
const fetch    = (...a) => import("node-fetch").then(m => m.default(...a));

const app  = express();
const PORT = 3000;

const DATA_FILE    = path.join(__dirname, "messages.json");
const LOG_FILE     = path.join(__dirname, "visitor.log");
const UPLOAD_DIR   = path.join(__dirname, "uploads");
const MAX_MESSAGES = 500;
const MAX_MSG_LEN  = 1000;
const MAX_USER_LEN = 32;
const MAX_FILE_MB  = 50;
const MAX_FILE_B   = MAX_FILE_MB * 1024 * 1024;

/* =========================
   ALLOWED TYPES
========================= */
const ALLOWED_MIME = new Set([
    "image/jpeg","image/png","image/gif","image/webp",
    "video/mp4","video/webm",
    "audio/mpeg","audio/ogg","audio/wav","audio/mp4",
    "application/pdf",
    "application/zip","application/x-zip-compressed",
    "text/plain",
]);

const TYPE_CATEGORY = (mime) => {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "file";
};

/* =========================
   ENSURE UPLOAD DIR
========================= */
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* =========================
   MIDDLEWARE
========================= */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

/* =========================
   LOGGER
========================= */
app.use((req, res, next) => {
    const ip   = getClientIP(req);
    const time = new Date().toISOString();
    const log  = `[${time}] ${ip} ${req.method} ${req.url}`;
    console.log(log);
    fs.appendFile(LOG_FILE, log + "\n", () => {});
    next();
});

/* =========================
   STATIC FILE SERVING
========================= */
app.use("/uploads", express.static(UPLOAD_DIR));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

/* =========================
   HELPERS
========================= */
function getClientIP(req) {
    return (
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        req.socket.remoteAddress || "unknown"
    ).replace("::ffff:", "");
}

function getServerIP() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const net of ifaces) {
            if (net.family === "IPv4" && !net.internal) return net.address;
        }
    }
    return null;
}

function sanitize(str) {
    return String(str)
        .replace(/&/g,"&amp;").replace(/</g,"&lt;")
        .replace(/>/g,"&gt;").replace(/"/g,"&quot;")
        .replace(/'/g,"&#039;");
}

function uniqueFilename(original) {
    const ext  = path.extname(original).toLowerCase();
    const base = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    return base + ext;
}

/* =========================
   PERSISTENT STORAGE
========================= */
let messages = [];

function loadMessages() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            messages = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
            console.log(`Loaded ${messages.length} messages.`);
        }
    } catch (e) {
        console.error("Load failed:", e);
        messages = [];
    }
}

function saveMessages() {
    fs.writeFile(DATA_FILE, JSON.stringify(messages, null, 2), () => {});
}

loadMessages();

/* =========================
   MULTER — disk storage
========================= */
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => cb(null, uniqueFilename(file.originalname)),
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_B },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
        cb(new Error(`File type not allowed: ${file.mimetype}`));
    },
});

/* =========================
   POST /send  — text message
========================= */
app.post("/send", (req, res) => {
    try {
        const ip          = getClientIP(req);
        const rawMessage  = req.body.message?.toString().trim();
        const rawUsername = req.body.username?.toString().trim() || "Anonymous";

        if (!rawMessage)
            return res.status(400).json({ success: false, error: "Message is required" });
        if (rawMessage.length > MAX_MSG_LEN)
            return res.status(400).json({ success: false, error: `Max ${MAX_MSG_LEN} chars` });
        if (rawUsername.length > MAX_USER_LEN)
            return res.status(400).json({ success: false, error: `Username too long` });

        const data = buildMessage({
            ip,
            username: sanitize(rawUsername),
            type:     "text",
            message:  sanitize(rawMessage),
        });

        pushMessage(data);
        res.status(201).json({ success: true, data });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

/* =========================
   POST /upload  — file message
========================= */
app.post("/upload", (req, res) => {
    upload.single("file")(req, res, async (err) => {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE")
            return res.status(400).json({ success: false, error: `Max file size is ${MAX_FILE_MB} MB` });
        if (err)
            return res.status(400).json({ success: false, error: err.message });
        if (!req.file)
            return res.status(400).json({ success: false, error: "No file uploaded" });

        const ip          = getClientIP(req);
        const rawUsername = req.body.username?.toString().trim() || "Anonymous";
        const mime        = req.file.mimetype;
        const category    = TYPE_CATEGORY(mime);
        let   filename    = req.file.filename;

        /* Auto-compress images (except gif) */
        if (category === "image" && mime !== "image/gif") {
            try {
                const compressedName = `c-${filename.replace(/\.[^.]+$/, ".webp")}`;
                const compressedPath = path.join(UPLOAD_DIR, compressedName);
                await sharp(req.file.path)
                    .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
                    .webp({ quality: 82 })
                    .toFile(compressedPath);
                fs.unlink(req.file.path, () => {});   // remove original
                filename = compressedName;
            } catch (e) {
                console.error("Sharp compression failed:", e);
                // fall through — serve original
            }
        }

        const data = buildMessage({
            ip,
            username:     sanitize(rawUsername),
            type:         category,
            message:      "",
            file: {
                url:          `/uploads/${filename}`,
                originalName: sanitize(req.file.originalname),
                mime,
                size:         req.file.size,
            },
        });

        pushMessage(data);
        res.status(201).json({ success: true, data });
    });
});

/* =========================
   GET /preview  — OG link preview
   ?url=https://...
========================= */
app.get("/preview", async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ success: false, error: "url param required" });

    let parsed;
    try { parsed = new URL(rawUrl); } catch {
        return res.status(400).json({ success: false, error: "Invalid URL" });
    }
    if (!["http:", "https:"].includes(parsed.protocol))
        return res.status(400).json({ success: false, error: "Only http/https allowed" });

    try {
        const response = await fetch(parsed.href, {
            headers: { "User-Agent": "GroupChatBot/1.0" },
            signal: AbortSignal.timeout(5000),
            redirect: "follow",
        });

        const html  = await response.text();
        const meta  = {};

        const extract = (prop) => {
            const m = html.match(
                new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i")
                || new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i")
            );
            return m?.[1]?.trim() || null;
        };

        meta.title       = extract("og:title")       || extract("twitter:title")
                        || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || parsed.hostname;
        meta.description = extract("og:description") || extract("twitter:description")
                        || extract("description")    || null;
        meta.image       = extract("og:image")       || extract("twitter:image") || null;
        meta.siteName    = extract("og:site_name")   || parsed.hostname;
        meta.url         = parsed.href;

        res.json({ success: true, data: meta });
    } catch (e) {
        res.status(502).json({ success: false, error: "Could not fetch preview" });
    }
});

/* =========================
   GET /msg  — fetch messages
========================= */
app.get("/msg", (req, res) => {
    const since  = req.query.since ? Number(req.query.since) : null;
    const result = since ? messages.filter(m => m.id > since) : messages;
    res.json({ success: true, total: messages.length, data: result });
});

/* =========================
   DELETE /msg  — clear chat
========================= */
app.delete("/msg", (req, res) => {
    const token = req.headers["authorization"];
    if (token !== `Bearer ${process.env.ADMIN_TOKEN || "changeme"}`)
        return res.status(401).json({ success: false, error: "Unauthorized" });
    messages = [];
    saveMessages();
    res.json({ success: true, message: "Cleared" });
});

/* =========================
   GET /health
========================= */
app.get("/health", (req, res) => {
    res.json({ success: true, uptime: process.uptime(), messages: messages.length });
});

/* =========================
   404
========================= */
app.use((req, res) => res.status(404).json({ success: false, error: "Not found" }));

/* =========================
   HELPERS
========================= */
function buildMessage(fields) {
    return {
        id:       Date.now(),
        ip:       fields.ip,
        username: fields.username,
        type:     fields.type,       // "text" | "image" | "video" | "audio" | "file"
        message:  fields.message,
        file:     fields.file || null,
        time:     new Date().toISOString(),
    };
}

function pushMessage(data) {
    messages.push(data);
    if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
    saveMessages();
    console.log("MSG:", data.type, data.username);
}

/* =========================
   SERVER START + SHUTDOWN
========================= */
const server = app.listen(PORT, "0.0.0.0", () => {
    console.log("\n=== CHAT SERVER RUNNING ===");
    console.log(`Local:   http://localhost:${PORT}`);
    const ip = getServerIP();
    if (ip) console.log(`Network: http://${ip}:${PORT}`);
    console.log("===========================\n");
});

function shutdown(sig) {
    console.log(`\n${sig} — saving and shutting down...`);
    saveMessages();
    server.close(() => { console.log("Done."); process.exit(0); });
    setTimeout(() => process.exit(1), 5000);
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));