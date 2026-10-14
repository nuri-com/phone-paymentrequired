// phone.paymentrequired.com: research-interview MCP + live operator page + own-words report.
// Node 22 stdlib only. Env names: see README.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { execSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { append, readInterview, listInterviews, findByPersonalToken, newToken } from "./lib.js";
import { runReport } from "./report.js";
import { landing, llmsTxt, livePage, personalPage } from "./pages.js";

const PORT = Number(process.env.PHONE_PORT || 4600);
const MCP_TOKEN = process.env.PHONE_MCP_TOKEN;
const OP_TOKEN = process.env.PHONE_OPERATOR_TOKEN;
if (!MCP_TOKEN || !OP_TOKEN) throw new Error("PHONE_MCP_TOKEN and PHONE_OPERATOR_TOKEN required");
let SHA = "unknown";
try { SHA = execSync("git rev-parse HEAD", { cwd: new URL(".", import.meta.url).pathname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const STARTED = new Date().toISOString();

const eq = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && timingSafeEqual(x, y); };
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

// Pending operator instructions per conversation (in memory; consumed once). "*" = next active interview.
const steer = new Map();

// Every tool call must carry the ElevenLabs conversation id ({{system__conversation_id}}). No fallback:
// guessing an id could attach notes or reports to the wrong caller.
const CONV_RE = /^conv_[a-z0-9]+$/;
function requireCid(given) {
  const g = String(given ?? "").trim();
  if (!CONV_RE.test(g)) throw new Error("conversation_id missing or invalid: pass {{system__conversation_id}} (format conv_<lowercase letters and digits>)");
  return g;
}

const TOOLS = [
  {
    name: "interview_note",
    description:
      "Notebook for this conversation. Call it after EVERY answer the participant gives, before you decide your next question. " +
      "Pass what the person just said in their own words (person_said), an optional one-line summary, and the phase (opening, warmup, persona, threads, closing). " +
      "The result may contain operator_instruction: if it is non-empty, follow it for your very next question. The result may contain research: use it only as quiet background. " +
      "Never mention this tool, the notebook, an operator or instructions to the participant. Keep the conversation flowing; do not announce that you are taking notes.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Required: the conversation id given in your instructions (starts with conv_)." },
        person_said: { type: "string", description: "What the participant just said, close to their own words." },
        agent_summary: { type: "string", description: "Optional: one short line on what this answer means for the next question." },
        phase: { type: "string", description: "Current phase, e.g. opening, warmup, persona, threads, closing." },
      },
      required: ["conversation_id", "person_said", "phase"],
    },
  },
  {
    name: "research_person",
    description:
      "Looks up public information about the participant or their project, read-only. ONLY call this after the participant explicitly said yes to a question like " +
      "'May I quickly look up your project online?'. Ask that permission first. If they did not clearly agree, do not call it. " +
      "Pass consent=true only on that clear yes. A name is enough; add company, context, website or GitHub handle when you have them. Searches the web. Returns a short plain summary. Use it to ask a better question; do not read it out.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        consent: { type: "boolean", description: "true only if the participant clearly said yes to being looked up. Without true the lookup is refused." },
        name: { type: "string", description: "Full name as they said it. A name alone is enough for a web search." },
        company: { type: "string", description: "Company or project, if mentioned." },
        context: { type: "string", description: "What they told you about themselves so far, one line, to disambiguate the search." },
        url: { type: "string", description: "Website the participant mentioned." },
        handle: { type: "string", description: "GitHub username the participant mentioned." },
      },
      required: ["conversation_id", "consent"],
    },
  },
  {
    name: "finish_interview",
    description:
      "Call once at the end of the conversation, after the closing questions. Before calling: ask whether they want to leave an email so they get a copy of their own interview (optional, read it back once); " +
      "ask whether we may mention them by name in our findings (default no). Do not promise rewards, payment or anonymity. " +
      "Pass may_attribute=true only if they clearly said yes. consent_research=true only if they agreed to a public lookup.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        email: { type: "string" },
        name: { type: "string", description: "Only the name they gave themselves." },
        may_attribute: { type: "boolean" },
        consent_research: { type: "boolean" },
      },
      required: ["conversation_id", "may_attribute", "consent_research"],
    },
  },
];
// interview_note stays callable but is not advertised: per-turn calls cost 2 to 10 s per turn on real calls.
const LISTED = TOOLS.filter((t) => t.name !== "interview_note");

// ---------- research (read-only, public) ----------
const stripHtml = (h) => String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const words = (s, n) => s.split(/\s+/).slice(0, n).join(" ");
// Outbound fetch for research: http/https on ports 80/443 only, every hop resolved and checked
// against private/loopback/link-local/metadata ranges, connection pinned to the checked address
// (no DNS rebinding), manual redirects (max 3), body capped at 512 KB.
const MAX_BODY = 512 * 1024, MAX_HOPS = 3;
const BLOCKED = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) BLOCKED.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]]) BLOCKED.addSubnet(a, p, "ipv6");
class UrlRefused extends Error {}
const isBlocked = (ip) => { const f = net.isIP(ip); return !f || BLOCKED.check(ip, f === 6 ? "ipv6" : "ipv4"); };

async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("invalid url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UrlRefused(`url refused: scheme ${u.protocol}`);
  if (u.port && u.port !== "80" && u.port !== "443") throw new UrlRefused(`url refused: port ${u.port}`);
  if (u.username || u.password) throw new UrlRefused("url refused: credentials in url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length) throw new Error(`${host} did not resolve`);
  const bad = addrs.find((a) => isBlocked(a.address));
  if (bad) throw new UrlRefused(`url refused: ${host} resolves to a non-public address`);
  return { u, host, addr: addrs[0] };
}

function getOnce({ u, host, addr }, accept, signal) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: host, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method: "GET",
      headers: { "user-agent": "nuri-phone-research/1", accept, host: u.host }, signal,
      ...(net.isIP(host) ? {} : { servername: host }),
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [addr]) : cb(null, addr.address, addr.family)),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.destroy(); return resolve({ redirect: res.headers.location, status: res.statusCode }); }
      const chunks = []; let n = 0;
      res.on("data", (c) => { if (n >= MAX_BODY) return; chunks.push(c); n += c.length; if (n >= MAX_BODY) { res.destroy(); finish(); } });
      res.on("end", () => finish());
      res.on("error", (e) => (n >= MAX_BODY ? finish() : reject(e)));
      let done = false;
      function finish() { if (done) return; done = true; resolve({ status: res.statusCode, body: Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8") }); }
    });
    req.on("error", reject);
    req.end();
  });
}

async function getText(url, json = false) {
  const signal = AbortSignal.timeout(8000);
  let next = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const target = await checkUrl(next);
    const r = await getOnce(target, json ? "application/json" : "text/html,*/*", signal);
    if (r.redirect) { next = new URL(r.redirect, target.u).toString(); continue; }
    if (r.status < 200 || r.status > 299) throw new Error(`${target.u.host} HTTP ${r.status}`);
    return json ? JSON.parse(r.body) : r.body;
  }
  throw new Error(`too many redirects (max ${MAX_HOPS})`);
}
function okUrl(u) {
  const s = String(u || "").trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) throw new UrlRefused("url refused: only http and https");
  return /^https?:\/\//i.test(s) ? s : "https://" + s;
}
// OpenRouter chat call; perplexity/sonar does the web search, the synthesis model only reads.
async function orChat(model, system, user, { max_tokens = 220, timeoutMs = 12000 } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("web search not configured");
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, max_tokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`${model} HTTP ${r.status}`);
  const j = await r.json();
  return String(j.choices?.[0]?.message?.content || "").replace(/\[\d+\]/g, "").replace(/\*\*/g, "").trim();
}
const SPELL = "The name was transcribed from speech and may be misspelled: search the given spelling and close variants (Amin/Emin, Mahrt/Mart/Maart, Jon/John, Meier/Meyer and so on) and use the context to pick the right person. Plain text, no markdown, no citations, max 70 words. If nothing plausible exists answer exactly: not found.";
// Fan-out: 4 searchers run in parallel, each with one angle; one fast model folds them into hooks.
const ANGLES = [
  ["identity", "Who is this person: current role, company, city, one-line background. Start with: match: <name as written online>, <confidence high|medium|low>."],
  ["public_voice", "Their most recent public posts, talks, interviews, podcast appearances or articles (last 2 years), with the concrete topic and where it appeared."],
  ["work", "What they built or shipped: products, companies, open source, with names and years; what they are working on right now."],
  ["money", "Anything public about their relationship with bitcoin, crypto, self-custody, wallets, exchanges, losses, hacks, banks or fintech: opinions, incidents, product choices."],
];
async function webResearch({ name, company, context }) {
  const who = [name, company, context].filter(Boolean).join(", ");
  const searchModel = process.env.RESEARCH_MODEL || "perplexity/sonar";
  const t0 = Date.now();
  const found = await Promise.allSettled(ANGLES.map(([, q]) => orChat(searchModel, `You research a person for a phone interviewer, public web sources only. ${q} ${SPELL}`, who, { max_tokens: 160 })));
  const notes = found.map((r, i) => `${ANGLES[i][0]}: ${r.status === "fulfilled" ? r.value : "error " + r.reason?.message}`);
  log({ research: "fanout", ms: Date.now() - t0, ok: found.filter((r) => r.status === "fulfilled").length });
  if (!found.some((r) => r.status === "fulfilled" && !/^not found\.?$/i.test(r.value.trim()))) return "not found";
  const sys = "You brief a phone interviewer, 30 seconds before the next question. Input: notes from four researchers about one person (may contain errors or not found). Output plain text, no markdown, max 110 words:\n" +
    "match: <name as written online>, <confidence high|medium|low>\n" +
    "facts: 2 lines, who they are and what they do\n" +
    "hooks: 3 lines, each one concrete, surprising, personal thing from the notes the interviewer can quote (what, where it appeared, when), best first. Prefer things about money, bitcoin, loss, trust, building. Never invent; if the notes are thin, fewer hooks.";
  try { return await orChat(process.env.RESEARCH_SYNTH_MODEL || "openai/gpt-4.1-mini", sys, notes.join("\n\n"), { max_tokens: 260, timeoutMs: 10000 }); }
  catch (e) { log({ research: "synth_failed", error: String(e.message || e) }); return words(notes.join(" "), 110); }
}
async function research({ name, company, url, handle, context }) {
  const parts = [];
  if (name || company) {
    try { parts.push(await webResearch({ name, company, context })); }
    catch (e) { parts.push(`Web search failed: ${e.message}.`); }
  }
  const h = String(handle || "").replace(/^@/, "").trim();
  if (/^[A-Za-z0-9-]{1,39}$/.test(h)) {
    try {
      const u = await getText(`https://api.github.com/users/${h}`, true);
      parts.push(`GitHub ${u.login}: ${[u.name, u.bio, u.company, u.location].filter(Boolean).join(", ")}; ${u.public_repos} public repos, ${u.followers} followers.`);
      const repos = await getText(`https://api.github.com/users/${h}/repos?sort=updated&per_page=5`, true);
      if (Array.isArray(repos) && repos.length) parts.push("Recent repos: " + repos.map((r) => `${r.name}${r.description ? " (" + words(r.description, 12) + ")" : ""}`).join("; ") + ".");
    } catch (e) { if (e instanceof UrlRefused) throw e; parts.push(`GitHub lookup failed: ${e.message}.`); }
  }
  const target = okUrl(url || "") || (company && /\./.test(company) ? okUrl(company) : null);
  if (target) {
    try {
      const html = await getText(target);
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
      const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || "";
      parts.push(`${new URL(target).host}: ${[title.trim(), desc.trim()].map((x) => x.replace(/&amp;/g, "&")).filter(Boolean).join(". ")}. ${words(stripHtml(html), 60)}`);
    } catch (e) { if (e instanceof UrlRefused) throw e; parts.push(`Website lookup failed: ${e.message}.`); }
  }
  if (!parts.length) parts.push(`No url or GitHub handle given${name || company ? ` for ${[name, company].filter(Boolean).join(", ")}` : ""}; nothing looked up. Ask for a website or GitHub name if useful.`);
  return words(parts.join(" "), 110);
}

// ---------- tool dispatch ----------
async function dispatch(name, args) {
  const t0 = Date.now();
  let cid = null;
  try {
    // research_person only logs; it must work even when the model did not pass the conversation id.
    cid = name === "research_person" && !/^conv_[a-z0-9]+$/.test(String(args.conversation_id || "")) ? null : requireCid(args.conversation_id);
    let out;
    if (name === "interview_note") {
      append(cid, { type: "turn", person_said: String(args.person_said || "").slice(0, 4000), agent_summary: String(args.agent_summary || "").slice(0, 500), phase: args.phase || null });
      const pending = steer.get(cid) || steer.get("*") || null;
      if (pending) { steer.delete(cid); steer.delete("*"); append(cid, { type: "steer_delivered", text: pending }); }
      const lastResearch = readInterview(cid)?.lines.filter((l) => l.type === "research").at(-1)?.summary || null;
      out = { operator_instruction: pending, research: lastResearch, conversation_id: cid };
    } else if (name === "research_person") {
      if (args.consent !== true) throw new Error("research_person refused: consent must be true (ask the participant first and only call after a clear yes)");
      const summary = await research(args);
      if (cid) append(cid, { type: "research", query: { name: args.name, company: args.company, context: args.context, url: args.url, handle: args.handle }, summary });
      out = { research: summary };
    } else if (name === "finish_interview") {
      const personal_token = newToken(20);
      const email = String(args.email || "").trim() || null;
      append(cid, { type: "finish", email, name: args.name || null, may_attribute: Boolean(args.may_attribute), consent_research: Boolean(args.consent_research), personal_token });
      setTimeout(() => {
        runReport(cid).then((r) => log({ job: "report", conversation_id: cid, ok: true, ...r }))
          .catch((e) => { log({ job: "report", conversation_id: cid, ok: false, error: String(e.message || e) }); append(cid, { type: "report_error", error: String(e.message || e) }); });
      }, 15000);
      out = { ok: true, message: "Saved. Thank the participant briefly and end the call." };
    } else {
      throw new Error(`unknown tool: ${name}`);
    }
    log({ tool: name, conversation_id: cid, ms: Date.now() - t0, ok: true });
    return out;
  } catch (e) {
    log({ tool: name, conversation_id: cid, ms: Date.now() - t0, ok: false, error: String(e.message || e) });
    throw e;
  }
}

// ---------- http ----------
const SEC_HEADERS = { "strict-transport-security": "max-age=31536000", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const send = (res, code, body, type = "application/json", extra = {}) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...SEC_HEADERS, ...extra });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const MAX_REQ = 1e6;
class TooLarge extends Error {}
class BadJson extends Error {}
const readBody = async (req) => {
  if (Number(req.headers["content-length"]) > MAX_REQ) throw new TooLarge();
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_REQ) throw new TooLarge(); chunks.push(c); }
  return Buffer.concat(chunks).toString("utf8");
};
const readJson = async (req) => { const raw = await readBody(req); try { return JSON.parse(raw || "{}"); } catch { throw new BadJson(); } };
// 413 and close: the rest of the oversized body is not read, so the connection cannot be reused.
const tooLarge = (res) => send(res, 413, { error: "payload too large" }, "application/json", { connection: "close" });
const cookieToken = (req) => (String(req.headers.cookie || "").match(/(?:^|;\s*)op=([a-f0-9]+)/) || [])[1];
const opOk = (req, url) => eq(url.searchParams.get("token") || cookieToken(req), OP_TOKEN);

async function handleMcp(req, res) {
  if (!eq(req.headers.authorization, `Bearer ${MCP_TOKEN}`)) return send(res, 401, { jsonrpc: "2.0", error: { code: -32600, message: "unauthorized" } });
  if (req.method === "GET") return send(res, 200, { jsonrpc: "2.0", result: { tools: LISTED } });
  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch (e) {
    if (e instanceof TooLarge) return tooLarge(res);
    return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" } });
  }
  const id = msg.id ?? null;
  const reply = (obj) => send(res, 200, { jsonrpc: "2.0", ...(id !== null ? { id } : {}), ...obj });
  if (msg.method === "initialize") return reply({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "interview-notes", version: "1.0.0" } } });
  if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) { res.writeHead(202, SEC_HEADERS); return res.end(); }
  if (msg.method === "ping") return reply({ result: {} });
  if (msg.method === "tools/list") return reply({ result: { tools: LISTED } });
  if (msg.method === "tools/call") {
    try {
      const out = await dispatch(msg.params?.name, msg.params?.arguments || {});
      return reply({ result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
    } catch (e) {
      return reply({ result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e.message || e) }) }], isError: true } });
    }
  }
  return reply({ error: { code: -32601, message: "method not found" } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/^\/phone-mcp(?=\/|$)/, "") || "/";
  try {
    if (p === "/mcp" || (url.pathname.startsWith("/phone-mcp") && p === "/")) return await handleMcp(req, res);
    if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true, service: "nuri-phone", sha: SHA, started: STARTED });
    if (req.method === "GET" && p === "/") return send(res, 200, landing(), "text/html; charset=utf-8");
    if (req.method === "GET" && p === "/llms.txt") return send(res, 200, llmsTxt(), "text/plain; charset=utf-8");
    if (req.method === "GET" && p === "/live") {
      if (!opOk(req, url)) return send(res, 401, "unauthorized", "text/plain");
      return send(res, 200, livePage(), "text/html; charset=utf-8", { "set-cookie": `op=${OP_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`, "x-robots-tag": "noindex" });
    }
    if (req.method === "GET" && p === "/api/interviews") {
      if (!opOk(req, url)) return send(res, 401, { error: "unauthorized" });
      const items = listInterviews(30).map((iv) => ({
        conversation_id: iv.conversation_id, started: iv.started, last: iv.last, finished: iv.finished,
        active: !iv.finished && Date.now() - Date.parse(iv.last) < 15 * 60 * 1000,
        pending_steer: steer.get(iv.conversation_id) || null,
        lines: iv.lines.map(({ personal_token, ...l }) => l),
      }));
      return send(res, 200, { items, pending_any: steer.get("*") || null });
    }
    if (req.method === "POST" && p === "/api/steer") {
      if (!opOk(req, url)) return send(res, 401, { error: "unauthorized" });
      const b = await readJson(req);
      const text = String(b.text || "").trim().slice(0, 1000);
      const cid = String(b.conversation_id || "*").replace(/[^A-Za-z0-9_*-]/g, "") || "*";
      if (!text) return send(res, 400, { error: "text required" });
      steer.set(cid, text);
      if (cid !== "*") append(cid, { type: "steer_queued", text });
      log({ api: "steer", conversation_id: cid, ok: true });
      return send(res, 200, { ok: true, queued_for: cid });
    }
    const m = p.match(/^\/i\/([a-f0-9]{32,64})$/);
    if (req.method === "GET" && m) {
      const iv = findByPersonalToken(m[1]);
      if (!iv) return send(res, 404, "not found", "text/plain");
      return send(res, 200, personalPage(iv), "text/html; charset=utf-8", { "x-robots-tag": "noindex" });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof TooLarge) return tooLarge(res);
    if (e instanceof BadJson) return send(res, 400, { error: "invalid json" });
    log({ http: p, ok: false, error: String(e.message || e) });
    return send(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, "127.0.0.1", () => log({ msg: `nuri-phone on 127.0.0.1:${PORT}`, sha: SHA }));

// Hang-up safety net: every 2 min, list conversations of our agent (since service start) at ElevenLabs; any that is done,
// longer than 20 s and has no finish/report line in our store gets a report from whatever was said.
// finish_interview stays the normal path.
const AGENT_ID = process.env.PHONE_AGENT_ID;
if (AGENT_ID && process.env.ELEVENLABS_API_KEY) {
  const sweep = async () => {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations?agent_id=${encodeURIComponent(AGENT_ID)}&page_size=20&call_start_after_unix=${Math.floor(Date.parse(STARTED) / 1000)}`,
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`conversations HTTP ${r.status}`);
    for (const c of (await r.json()).conversations || []) {
      if (c.status !== "done" || (c.call_duration_secs || 0) < 20 || !CONV_RE.test(c.conversation_id)) continue;
      const iv = readInterview(c.conversation_id);
      if (iv && (iv.finished || iv.report || iv.lines.some((l) => l.type === "report_error" || l.type === "hangup"))) continue;
      append(c.conversation_id, { type: "hangup", call_duration_secs: c.call_duration_secs, termination_reason: c.termination_reason || null });
      try { const out = await runReport(c.conversation_id); log({ job: "report", via: "hangup", conversation_id: c.conversation_id, ok: true, ...out }); }
      catch (e) { log({ job: "report", via: "hangup", conversation_id: c.conversation_id, ok: false, error: String(e.message || e) }); append(c.conversation_id, { type: "report_error", error: String(e.message || e) }); }
    }
  };
  setInterval(() => sweep().catch((e) => log({ job: "sweep", ok: false, error: String(e.message || e) })), 120000).unref();
}
