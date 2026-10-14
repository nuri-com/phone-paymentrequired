// Shared helpers: interview store (JSON lines), router LLM call, Resend email.
import { appendFileSync, readFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const DATA_DIR = process.env.PHONE_DATA_DIR || new URL("./data/", import.meta.url).pathname;
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const safeId = (id) => String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
export const newToken = (n = 16) => randomBytes(n).toString("hex");
const file = (cid) => join(DATA_DIR, `${safeId(cid)}.jsonl`);

export function append(cid, rec) {
  const id = safeId(cid);
  if (!id) throw new Error("conversation id missing");
  appendFileSync(file(id), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n", { mode: 0o600 });
}

export function readInterview(cid) {
  const f = file(cid);
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const finish = [...lines].reverse().find((l) => l.type === "finish") || null;
  const report = [...lines].reverse().find((l) => l.type === "report") || null;
  return {
    conversation_id: safeId(cid),
    started: lines[0]?.ts || null,
    last: lines.at(-1)?.ts || null,
    finished: Boolean(finish),
    finish,
    report,
    lines,
  };
}

export function listInterviews(limit = 30) {
  return readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ id: f.slice(0, -6), m: statSync(join(DATA_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map(({ id }) => readInterview(id));
}

export function findByPersonalToken(token) {
  const t = String(token || "");
  if (!/^[a-f0-9]{32,64}$/.test(t)) return null;
  for (const f of readdirSync(DATA_DIR).filter((x) => x.endsWith(".jsonl"))) {
    const iv = readInterview(f.slice(0, -6));
    if (iv?.lines.some((l) => l.type === "finish" && l.personal_token === t)) return iv;
  }
  return null;
}

// OpenAI-compatible chat call through our router; reasoning models may answer in reasoning_content.
const ROUTER = "https://router.paymentrequired.com/v1/internal";
export async function llm(messages, { model, max_tokens = 4000, timeoutMs = 90000 } = {}) {
  const ups = [
    { url: ROUTER, key: process.env.ROUTER_INTERNAL_KEY, model: model || process.env.REPORT_MODEL || "claude-sonnet-5-5" },
    { url: ROUTER, key: process.env.ROUTER_INTERNAL_KEY, model: "claude-haiku-4-5-20251001" },
    { url: process.env.VOICE_LLM_UPSTREAM_URL, key: process.env.VOICE_LLM_UPSTREAM_KEY, model: process.env.VOICE_LLM_UPSTREAM_MODEL },
  ];
  const errors = [];
  for (const u of ups) {
    if (!u.url || !u.key || !u.model) continue;
    try {
      const r = await fetch(u.url.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${u.key}` },
        body: JSON.stringify({ model: u.model, messages, max_tokens, temperature: 0.2 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`${u.model} HTTP ${r.status}`);
      const m = (await r.json()).choices?.[0]?.message || {};
      const text = m.content || m.reasoning_content || "";
      if (!text.trim()) throw new Error(`${u.model} empty`);
      return { text, model: u.model };
    } catch (e) { errors.push(String(e.message || e)); }
  }
  throw new Error("llm failed: " + errors.join("; "));
}

// Resend, same pattern as nuri-support/resend-email.js.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
export const validEmail = (e) => EMAIL_RE.test(String(e || "").trim());
export async function sendMail({ to, subject, text, idempotencyKey }) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) throw new Error("email sending is not configured");
  const recipient = String(to || "").trim().toLowerCase();
  if (!validEmail(recipient)) throw new Error("invalid recipient email");
  const headers = { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" };
  if (idempotencyKey) headers["idempotency-key"] = String(idempotencyKey).slice(0, 256);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to: [recipient],
      subject: String(subject).replace(/[\r\n]+/g, " ").slice(0, 200),
      text: String(text).slice(0, 200000),
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;white-space:pre-wrap">${esc(text)}</div>`,
      ...(process.env.RESEND_REPLY_TO ? { reply_to: process.env.RESEND_REPLY_TO } : {}),
      tags: [{ name: "source", value: "nuri-phone" }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || typeof data.id !== "string") throw new Error(`Resend rejected email (${data.name || data.message || r.status})`);
  return { id: data.id, to: recipient };
}
