// Single Vercel function that serves every /api/* route (see vercel.json rewrites).
import { neon } from "@neondatabase/serverless";
import { put, del } from "@vercel/blob";
import crypto from "node:crypto";

// ---- lib/db.js ----

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const sql = url ? neon(url) : null;

let ready;
// Creates the tables the first time any API route runs.
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
  })().catch((e) => { ready = undefined; throw e; });
  return ready;
}

// ---- lib/http.js ----
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

// ---- lib/auth.js ----

const SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
const COOKIE = "pk_admin";
const DAYS = 7;

const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("hex");
const same = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

function checkPassword(pw) {
  return Boolean(process.env.ADMIN_PASSWORD) && same(pw, process.env.ADMIN_PASSWORD);
}
function loginCookie() {
  const exp = Date.now() + DAYS * 864e5;
  const token = `${exp}.${sign(`admin:${exp}`)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${DAYS * 86400}`;
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

// ---- api/rsvp.js ----

async function H_rsvp(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  try {
    const b = req.body || {};
    if (b.website) return send(res, 200, { ok: true }); // spam trap
    const name = clean(b.name, 80);
    if (!name) return send(res, 400, { error: "Please add your name." });
    const attending = b.attend === "yes";
    const guests = attending ? Math.min(Math.max(parseInt(b.count, 10) || 1, 1), 6) : 0;
    await initDb();
    await sql`INSERT INTO rsvps (name, phone, attending, guests, side, note)
      VALUES (${name}, ${clean(b.phone, 30)}, ${attending}, ${guests}, ${clean(b.side, 40)}, ${clean(b.note, 500)})`;
    send(res, 201, { ok: true });
  } catch (e) { fail(res, e); }
}

// ---- api/messages.js ----

async function H_messages(req, res) {
  try {
    await initDb();
    if (req.method === "GET") {
      const rows = await sql`SELECT id, name, body, created_at FROM messages
        WHERE status = 'approved' ORDER BY created_at DESC LIMIT 100`;
      return send(res, 200, { messages: rows });
    }
    if (req.method === "POST") {
      const b = req.body || {};
      if (b.website) return send(res, 200, { ok: true });
      const name = clean(b.name, 60), body = clean(b.body, 600);
      if (!name || !body) return send(res, 400, { error: "Please add your name and a message." });
      await sql`INSERT INTO messages (name, body) VALUES (${name}, ${body})`;
      return send(res, 201, { ok: true });
    }
    send(res, 405, { error: "Use GET or POST." });
  } catch (e) { fail(res, e); }
}

// ---- api/photos.js ----


async function H_photos(req, res) {
  try {
    await initDb();
    if (req.method === "GET") {
      const rows = await sql`SELECT id, name, caption, url, created_at FROM photos
        WHERE status = 'approved' ORDER BY created_at DESC LIMIT 200`;
      return send(res, 200, { photos: rows });
    }
    if (req.method === "POST") {
      const b = req.body || {};
      if (b.website) return send(res, 200, { ok: true });
      const name = clean(b.name, 60);
      const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(b.image || ""));
      if (!name || !m) return send(res, 400, { error: "Please add your name and choose a photo." });
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 3.5 * 1024 * 1024) return send(res, 413, { error: "That photo is too large. Try a smaller one." });
      const ext = m[1] === "jpeg" ? "jpg" : m[1];
      const blob = await put(`guest-photos/${crypto.randomUUID()}.${ext}`, buf, {
        access: "public", contentType: `image/${m[1]}`,
      });
      await sql`INSERT INTO photos (name, caption, url) VALUES (${name}, ${clean(b.caption, 200)}, ${blob.url})`;
      return send(res, 201, { ok: true });
    }
    send(res, 405, { error: "Use GET or POST." });
  } catch (e) { fail(res, e); }
}

// ---- api/admin/login.js ----

async function H_admin_login(req, res) {
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

// ---- api/admin/data.js ----

async function H_admin_data(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: "Please sign in." });
  try {
    await initDb();
    const [rsvps, messages, photos] = await Promise.all([
      sql`SELECT * FROM rsvps ORDER BY created_at DESC`,
      sql`SELECT * FROM messages ORDER BY (status = 'pending') DESC, created_at DESC`,
      sql`SELECT * FROM photos ORDER BY (status = 'pending') DESC, created_at DESC`,
    ]);
    send(res, 200, { rsvps, messages, photos });
  } catch (e) { fail(res, e); }
}

// ---- api/admin/moderate.js ----

async function H_admin_moderate(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: "Please sign in." });
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  try {
    await initDb();
    const { type, action } = req.body || {};
    const id = parseInt((req.body || {}).id, 10);
    if (!id) return send(res, 400, { error: "Missing id." });
    if (type === "message" || type === "photo") {
      if (action === "approve" || action === "reject" || action === "pending") {
        const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "pending";
        if (type === "message") await sql`UPDATE messages SET status = ${status} WHERE id = ${id}`;
        else await sql`UPDATE photos SET status = ${status} WHERE id = ${id}`;
        return send(res, 200, { ok: true });
      }
      if (action === "delete") {
        if (type === "message") await sql`DELETE FROM messages WHERE id = ${id}`;
        else {
          const rows = await sql`DELETE FROM photos WHERE id = ${id} RETURNING url`;
          if (rows[0]?.url) await del(rows[0].url).catch(() => {});
        }
        return send(res, 200, { ok: true });
      }
    }
    if (type === "rsvp" && action === "delete") {
      await sql`DELETE FROM rsvps WHERE id = ${id}`;
      return send(res, 200, { ok: true });
    }
    send(res, 400, { error: "Unknown action." });
  } catch (e) { fail(res, e); }
}

// ---- api/admin/export.js ----

const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function H_admin_export(req, res) {
  if (!isAdmin(req)) return send(res, 401, { error: "Please sign in." });
  try {
    await initDb();
    const rows = await sql`SELECT * FROM rsvps ORDER BY created_at`;
    const head = ["Name", "Phone", "Attending", "Guests", "Celebrating with", "Note", "Replied at"];
    const lines = rows.map((r) => [r.name, r.phone, r.attending ? "Yes" : "No", r.guests, r.side, r.note,
      new Date(r.created_at).toISOString()].map(cell).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="rsvps.csv"');
    res.end("﻿" + [head.map(cell).join(","), ...lines].join("\n"));
  } catch (e) { fail(res, e); }
}

// ---- router ----
const ROUTES = {
  "rsvp": H_rsvp, "messages": H_messages, "photos": H_photos,
  "admin/login": H_admin_login, "admin/data": H_admin_data, "admin/moderate": H_admin_moderate, "admin/export": H_admin_export,
};
export default async function handler(req, res) {
  const path = String(req.query.path || "").replace(/^\/+|\/+$/g, "");
  const fn = ROUTES[path];
  if (!fn) return send(res, 404, { error: "Not found." });
  return fn(req, res);
}
