// One Vercel function that serves every /api/* route (see vercel.json rewrites).
import { neon } from "@neondatabase/serverless";
import { put, del } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import crypto from "node:crypto";

/* ======================= database ======================= */
const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const sql = DB_URL ? neon(DB_URL) : null;
let ready;
function initDb() {
  if (!sql) throw new Error("Database is not connected. Add a Postgres database in Vercel → Storage.");
  ready ||= (async () => {
    await sql`CREATE TABLE IF NOT EXISTS rsvps (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT, attending BOOLEAN NOT NULL,
      guests INT NOT NULL DEFAULT 1, side TEXT, note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, caption TEXT, url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS gifts (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, note TEXT, price TEXT, link TEXT, image TEXT,
      sort INT NOT NULL DEFAULT 0, reserved_by TEXT, reserved_contact TEXT, reserved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS pledges (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, contact TEXT, amount BIGINT NOT NULL, message TEXT,
      status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  })().catch((e) => { ready = undefined; throw e; });
  return ready;
}

/* ======================= content defaults ======================= */
const GALLERY = ["7570", "8140", "7561", "8046", "7599", "8069", "7540", "8073"].map((n) => ({ url: `/${n}.jpg`, alt: "Paulla and Kingson" }));
const DEFAULTS = {
  bride: "Paulla",
  groom: "Kingson",
  date_iso: "2026-12-05T12:00",
  city: "Port Harcourt",
  venue_name: "",
  venue_address: "",
  time_label: "",
  dress_code: "Rose gold & purple",
  dress_note: "",
  invite_line: "Together with their families, Paulla and Kingson joyfully invite you to celebrate their wedding.",
  families: "The families of Pastor Eugene Ekwueme & Chief Marcellus Ejikeme",
  rsvp_deadline: "",
  whatsapp: "",
  song_url: "/song.mp3",
  song_title: "Our Theme",
  song_artist: "Paulla & Kingson",
  cash_title: "Cash gift",
  cash_note: "Your presence is the greatest gift. If you'd like to bless us further, you can send a gift here.",
  cash_details: "",
  fund_goal: "1500000",
  fund_note: "Help us make memories on our honeymoon. Every contribution brings us closer.",
  travel_note: "Port Harcourt International Airport (PHC), Omagwa, has daily flights from Abuja and Lagos. December fares climb quickly, so book early.",
  stay_note: "",
  faq: "[]",
  gallery: JSON.stringify(GALLERY),
};

async function getSettings() {
  const rows = await sql`SELECT key, value FROM settings`;
  const out = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS) out[r.key] = r.value;
  return out;
}

/* ======================= http helpers ======================= */
function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
function fail(res, err) {
  console.error(err);
  send(res, 500, { error: "Something went wrong on our side. Please try again in a moment." });
}
const isHttpUrl = (u) => /^(https?:\/\/|\/)[^\s]*$/i.test(String(u || ""));

/* ======================= admin auth ======================= */
const SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
const COOKIE = "pk_admin";
const DAYS = 7;
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
const same = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const checkPassword = (pw) => Boolean(process.env.ADMIN_PASSWORD) && same(pw, process.env.ADMIN_PASSWORD);
function loginCookie() {
  const exp = Date.now() + DAYS * 864e5;
  return `${COOKIE}=${exp}.${sign(`admin:${exp}`)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DAYS * 86400}`;
}
const logoutCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
function isAdmin(req) {
  if (!SECRET) return false;
  const raw = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return same(sig, sign(`admin:${exp}`));
}

/* ======================= public routes ======================= */
async function content(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "Use GET." });
  await initDb();
  const [settings, gifts, fund] = await Promise.all([
    getSettings(),
    sql`SELECT id, title, note, price, link, image, (reserved_by IS NOT NULL) AS reserved FROM gifts ORDER BY sort, id`,
    sql`SELECT COALESCE(SUM(amount) FILTER (WHERE status = 'received'), 0)::bigint AS raised, COUNT(*)::int AS pledges FROM pledges`,
  ]);
  res.setHeader("Cache-Control", "no-store");
  send(res, 200, {
    settings: { ...settings, cash_details: settings.cash_details },
    gifts,
    fund: { goal: Number(settings.fund_goal) || 0, raised: Number(fund[0].raised), pledges: fund[0].pledges },
  });
}

async function rsvp(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const b = req.body || {};
  if (b.website) return send(res, 200, { ok: true });
  const name = clean(b.name, 80);
  if (!name) return send(res, 400, { error: "Please add your name." });
  const attending = b.attend === "yes";
  const guests = attending ? Math.min(Math.max(parseInt(b.count, 10) || 1, 1), 6) : 0;
  await initDb();
  await sql`INSERT INTO rsvps (name, phone, attending, guests, side, note)
    VALUES (${name}, ${clean(b.phone, 30)}, ${attending}, ${guests}, ${clean(b.side, 40)}, ${clean(b.note, 500)})`;
  send(res, 201, { ok: true });
}

async function messages(req, res) {
  await initDb();
  if (req.method === "GET") {
    const rows = await sql`SELECT id, name, body, created_at FROM messages WHERE status = 'approved' ORDER BY created_at DESC LIMIT 100`;
    return send(res, 200, { messages: rows });
  }
  if (req.method !== "POST") return send(res, 405, { error: "Use GET or POST." });
  const b = req.body || {};
  if (b.website) return send(res, 200, { ok: true });
  const name = clean(b.name, 60), body = clean(b.body, 600);
  if (!name || !body) return send(res, 400, { error: "Please add your name and a message." });
  await sql`INSERT INTO messages (name, body) VALUES (${name}, ${body})`;
  send(res, 201, { ok: true });
}

function decodeImage(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  return { buf, type: m[1], ext: m[1] === "jpeg" ? "jpg" : m[1] };
}

async function photos(req, res) {
  await initDb();
  if (req.method === "GET") {
    const rows = await sql`SELECT id, name, caption, url, created_at FROM photos WHERE status = 'approved' ORDER BY created_at DESC LIMIT 200`;
    return send(res, 200, { photos: rows });
  }
  if (req.method !== "POST") return send(res, 405, { error: "Use GET or POST." });
  const b = req.body || {};
  if (b.website) return send(res, 200, { ok: true });
  const name = clean(b.name, 60), img = decodeImage(b.image);
  if (!name || !img) return send(res, 400, { error: "Please add your name and choose a photo." });
  if (img.buf.length > 3.5 * 1024 * 1024) return send(res, 413, { error: "That photo is too large. Try a smaller one." });
  const blob = await put(`guest-photos/${crypto.randomUUID()}.${img.ext}`, img.buf, { access: "public", contentType: `image/${img.type}` });
  await sql`INSERT INTO photos (name, caption, url) VALUES (${name}, ${clean(b.caption, 200)}, ${blob.url})`;
  send(res, 201, { ok: true });
}

async function reserveGift(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const b = req.body || {};
  if (b.website) return send(res, 200, { ok: true });
  const id = parseInt(b.id, 10), name = clean(b.name, 60);
  if (!id || !name) return send(res, 400, { error: "Please add your name." });
  await initDb();
  const rows = await sql`UPDATE gifts SET reserved_by = ${name}, reserved_contact = ${clean(b.contact, 60)}, reserved_at = now()
    WHERE id = ${id} AND reserved_by IS NULL RETURNING id`;
  if (!rows.length) return send(res, 409, { error: "Someone has just reserved this gift. Please choose another." });
  send(res, 200, { ok: true });
}

async function pledge(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const b = req.body || {};
  if (b.website) return send(res, 200, { ok: true });
  const name = clean(b.name, 60);
  const amount = Math.round(Number(String(b.amount || "").replace(/[^\d.]/g, "")));
  if (!name) return send(res, 400, { error: "Please add your name." });
  if (!amount || amount < 100 || amount > 1e9) return send(res, 400, { error: "Please enter an amount in naira." });
  await initDb();
  await sql`INSERT INTO pledges (name, contact, amount, message) VALUES (${name}, ${clean(b.contact, 60)}, ${amount}, ${clean(b.message, 300)})`;
  send(res, 201, { ok: true });
}

/* ======================= admin routes ======================= */
async function adminLogin(req, res) {
  if (req.method === "GET") return send(res, 200, { admin: isAdmin(req) });
  if (req.method === "DELETE") { res.setHeader("Set-Cookie", logoutCookie()); return send(res, 200, { ok: true }); }
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  if (!process.env.ADMIN_PASSWORD) return send(res, 500, { error: "ADMIN_PASSWORD is not set in Vercel yet." });
  if (!checkPassword((req.body || {}).password || "")) {
    await new Promise((r) => setTimeout(r, 800));
    return send(res, 401, { error: "That password isn't right." });
  }
  res.setHeader("Set-Cookie", loginCookie());
  send(res, 200, { ok: true });
}

async function adminData(req, res) {
  await initDb();
  const [rsvps, msgs, pics, gifts, pledges, settings] = await Promise.all([
    sql`SELECT * FROM rsvps ORDER BY created_at DESC`,
    sql`SELECT * FROM messages ORDER BY (status = 'pending') DESC, created_at DESC`,
    sql`SELECT * FROM photos ORDER BY (status = 'pending') DESC, created_at DESC`,
    sql`SELECT * FROM gifts ORDER BY sort, id`,
    sql`SELECT * FROM pledges ORDER BY (status = 'pending') DESC, created_at DESC`,
    getSettings(),
  ]);
  send(res, 200, { rsvps, messages: msgs, photos: pics, gifts, pledges, settings, defaults: DEFAULTS });
}

async function adminSettings(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const values = (req.body || {}).values || {};
  await initDb();
  for (const [k, v] of Object.entries(values)) {
    if (!(k in DEFAULTS)) continue;
    let val = String(v ?? "").slice(0, 20000);
    if (k === "gallery" || k === "faq") { try { if (!Array.isArray(JSON.parse(val))) throw 0; } catch { return send(res, 400, { error: `${k} must be a list.` }); } }
    if (k === "song_url" && val && !isHttpUrl(val)) return send(res, 400, { error: "Song must be a link or /file path." });
    await sql`INSERT INTO settings (key, value) VALUES (${k}, ${val}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  }
  send(res, 200, { ok: true });
}

async function adminGift(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const b = req.body || {};
  await initDb();
  const id = parseInt(b.id, 10) || 0;
  const title = clean(b.title, 120);
  if (!title) return send(res, 400, { error: "Please give the gift a name." });
  const link = clean(b.link, 500), image = clean(b.image, 500);
  if (link && !isHttpUrl(link)) return send(res, 400, { error: "The shop link must start with https://" });
  if (id) await sql`UPDATE gifts SET title=${title}, note=${clean(b.note, 300)}, price=${clean(b.price, 40)}, link=${link}, image=${image}, sort=${parseInt(b.sort, 10) || 0} WHERE id=${id}`;
  else await sql`INSERT INTO gifts (title, note, price, link, image, sort) VALUES (${title}, ${clean(b.note, 300)}, ${clean(b.price, 40)}, ${link}, ${image}, ${parseInt(b.sort, 10) || 0})`;
  send(res, 200, { ok: true });
}

async function adminImage(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const img = decodeImage((req.body || {}).image);
  if (!img) return send(res, 400, { error: "Choose a JPG, PNG or WebP image." });
  if (img.buf.length > 4 * 1024 * 1024) return send(res, 413, { error: "That image is too large." });
  const blob = await put(`site/${crypto.randomUUID()}.${img.ext}`, img.buf, { access: "public", contentType: `image/${img.type}` });
  send(res, 200, { url: blob.url });
}

async function adminUpload(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  try {
    const json = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/ogg", "image/jpeg", "image/png", "image/webp"],
        maximumSizeInBytes: 40 * 1024 * 1024,
        addRandomSuffix: true,
      }),
    });
    send(res, 200, json);
  } catch (e) {
    console.error(e);
    send(res, 400, { error: String(e.message || e).includes("token") ? "File uploads need BLOB_READ_WRITE_TOKEN in Vercel settings." : "Upload could not start. Try again." });
  }
}

async function adminModerate(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  await initDb();
  const { type, action } = req.body || {};
  const id = parseInt((req.body || {}).id, 10);
  if (!id) return send(res, 400, { error: "Missing id." });
  const ok = () => send(res, 200, { ok: true });
  if (type === "message" || type === "photo") {
    const status = { approve: "approved", reject: "rejected", pending: "pending" }[action];
    if (status) {
      if (type === "message") await sql`UPDATE messages SET status = ${status} WHERE id = ${id}`;
      else await sql`UPDATE photos SET status = ${status} WHERE id = ${id}`;
      return ok();
    }
    if (action === "delete") {
      if (type === "message") await sql`DELETE FROM messages WHERE id = ${id}`;
      else { const r = await sql`DELETE FROM photos WHERE id = ${id} RETURNING url`; if (r[0]?.url) await del(r[0].url).catch(() => {}); }
      return ok();
    }
  }
  if (type === "rsvp" && action === "delete") { await sql`DELETE FROM rsvps WHERE id = ${id}`; return ok(); }
  if (type === "pledge") {
    if (action === "received") { await sql`UPDATE pledges SET status = 'received' WHERE id = ${id}`; return ok(); }
    if (action === "pending") { await sql`UPDATE pledges SET status = 'pending' WHERE id = ${id}`; return ok(); }
    if (action === "delete") { await sql`DELETE FROM pledges WHERE id = ${id}`; return ok(); }
  }
  if (type === "gift") {
    if (action === "unreserve") { await sql`UPDATE gifts SET reserved_by = NULL, reserved_contact = NULL, reserved_at = NULL WHERE id = ${id}`; return ok(); }
    if (action === "delete") { await sql`DELETE FROM gifts WHERE id = ${id}`; return ok(); }
  }
  send(res, 400, { error: "Unknown action." });
}

const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
async function adminExport(req, res) {
  await initDb();
  const rows = await sql`SELECT * FROM rsvps ORDER BY created_at`;
  const head = ["Name", "Phone", "Attending", "Guests", "Celebrating with", "Note", "Replied at"];
  const lines = rows.map((r) => [r.name, r.phone, r.attending ? "Yes" : "No", r.guests, r.side, r.note, new Date(r.created_at).toISOString()].map(cell).join(","));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="rsvps.csv"');
  res.end("﻿" + [head.map(cell).join(","), ...lines].join("\n"));
}

/* ======================= router ======================= */
const PUBLIC = { content, rsvp, messages, photos, "gifts/reserve": reserveGift, pledge, "admin/login": adminLogin };
const ADMIN = {
  "admin/data": adminData, "admin/settings": adminSettings, "admin/gift": adminGift, "admin/image": adminImage,
  "admin/upload": adminUpload, "admin/moderate": adminModerate, "admin/export": adminExport,
};
export default async function handler(req, res) {
  const path = String(req.query.path || "").replace(/^\/+|\/+$/g, "");
  try {
    if (PUBLIC[path]) return await PUBLIC[path](req, res);
    if (ADMIN[path]) {
      if (!isAdmin(req)) return send(res, 401, { error: "Please sign in." });
      return await ADMIN[path](req, res);
    }
    send(res, 404, { error: "Not found." });
  } catch (e) { fail(res, e); }
}
