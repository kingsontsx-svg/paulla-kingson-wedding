import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
export const sql = url ? neon(url) : null;

let ready;
// Creates the tables the first time any API route runs.
export function initDb() {
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
