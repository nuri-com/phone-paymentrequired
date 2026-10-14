// phone.paymentrequired.com: research-interview MCP + live operator page + own-words report.
// Node 22 stdlib only. Env names: see README.
import http from "node:http";
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
const lastActive = { id: null, at: 0 };

function resolveCid(given) {
  const g = String(given || "").trim();
  if (/^[A-Za-z0-9_-]{6,80}$/.test(g) && !/\{\{/.test(g)) return g;
  // no usable id: reuse the most recent active interview for 20 min, else start a local one
  if (lastActive.id && Date.now() - lastActive.at < 20 * 60 * 1000) return lastActive.id;
  return "local_" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "_" + newToken(3);
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
        conversation_id: { type: "string", description: "The conversation id given in your instructions (starts with conv_), if known." },
        person_said: { type: "string", description: "What the participant just said, close to their own words." },
        agent_summary: { type: "string", description: "Optional: one short line on what this answer means for the next question." },
        phase: { type: "string", description: "Current phase, e.g. opening, warmup, persona, threads, closing." },
      },
      required: ["person_said", "phase"],
    },
  },
  {
    name: "research_person",
    description:
      "Looks up public information about the participant or their project, read-only. ONLY call this after the participant explicitly said yes to a question like " +
      "'May I quickly look up your project online?'. Ask that permission first. If they did not clearly agree, do not call it. " +
      "Give a website url, a GitHub handle, a company or a name. Returns a short plain summary. Use it to ask a better question; do not read it out.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        name: { type: "string" },
        company: { type: "string" },
        url: { type: "string", description: "Website the participant mentioned." },
        handle: { type: "string", description: "GitHub username the participant mentioned." },
      },
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
      required: ["may_attribute", "consent_research"],
    },
  },
];

// ---------- research (read-only, public) ----------
const stripHtml = (h) => String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const words = (s, n) => s.split(/\s+/).slice(0, n).join(" ");
async function getText(url, json = false) {
  const r = await fetch(url, { headers: { "user-agent": "nuri-phone-research/1", accept: json ? "application/json" : "text/html,*/*" }, signal: AbortSignal.timeout(8000), redirect: "follow" });
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return json ? r.json() : (await r.text()).slice(0, 400000);
}
function okUrl(u) {
  try {
    const x = new URL(/^https?:\/\//.test(u) ? u : "https://" + u);
    if (!/^https?:$/.test(x.protocol)) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(x.hostname)) return null;
    return x.toString();
  } catch { return null; }
}
async function research({ name, company, url, handle }) {
  const parts = [];
  const h = String(handle || "").replace(/^@/, "").trim();
  if (/^[A-Za-z0-9-]{1,39}$/.test(h)) {
    try {
      const u = await getText(`https://api.github.com/users/${h}`, true);
      parts.push(`GitHub ${u.login}: ${[u.name, u.bio, u.company, u.location].filter(Boolean).join(", ")}; ${u.public_repos} public repos, ${u.followers} followers.`);
      const repos = await getText(`https://api.github.com/users/${h}/repos?sort=updated&per_page=5`, true);
      if (Array.isArray(repos) && repos.length) parts.push("Recent repos: " + repos.map((r) => `${r.name}${r.description ? " (" + words(r.description, 12) + ")" : ""}`).join("; ") + ".");
    } catch (e) { parts.push(`GitHub lookup failed: ${e.message}.`); }
  }
  const target = okUrl(url || "") || (company && /\./.test(company) ? okUrl(company) : null);
  if (target) {
    try {
      const html = await getText(target);
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
      const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || "";
      parts.push(`${new URL(target).host}: ${[title.trim(), desc.trim()].map((x) => x.replace(/&amp;/g, "&")).filter(Boolean).join(". ")}. ${words(stripHtml(html), 60)}`);
    } catch (e) { parts.push(`Website lookup failed: ${e.message}.`); }
  }
  if (!parts.length) parts.push(`No url or GitHub handle given${name || company ? ` for ${[name, company].filter(Boolean).join(", ")}` : ""}; nothing looked up. Ask for a website or GitHub name if useful.`);
  return words(parts.join(" "), 120);
}

// ---------- tool dispatch ----------
async function dispatch(name, args) {
  const t0 = Date.now();
  const cid = resolveCid(args.conversation_id);
  try {
    let out;
    if (name === "interview_note") {
      lastActive.id = cid; lastActive.at = Date.now();
      append(cid, { type: "turn", person_said: String(args.person_said || "").slice(0, 4000), agent_summary: String(args.agent_summary || "").slice(0, 500), phase: args.phase || null });
      const pending = steer.get(cid) || steer.get("*") || null;
      if (pending) { steer.delete(cid); steer.delete("*"); append(cid, { type: "steer_delivered", text: pending }); }
      const lastResearch = readInterview(cid)?.lines.filter((l) => l.type === "research").at(-1)?.summary || null;
      out = { operator_instruction: pending, research: lastResearch, conversation_id: cid };
    } else if (name === "research_person") {
      lastActive.id = cid; lastActive.at = Date.now();
      const summary = await research(args);
      append(cid, { type: "research", query: { name: args.name, company: args.company, url: args.url, handle: args.handle }, summary });
      out = { research: summary };
    } else if (name === "finish_interview") {
      const personal_token = newToken(20);
      const email = String(args.email || "").trim() || null;
      append(cid, { type: "finish", email, name: args.name || null, may_attribute: Boolean(args.may_attribute), consent_research: Boolean(args.consent_research), personal_token });
      if (lastActive.id === cid) lastActive.id = null;
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
const send = (res, code, body, type = "application/json", extra = {}) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const readBody = async (req) => { let raw = ""; for await (const c of req) { raw += c; if (raw.length > 1e6) throw new Error("too large"); } return raw; };
const cookieToken = (req) => (String(req.headers.cookie || "").match(/(?:^|;\s*)op=([a-f0-9]+)/) || [])[1];
const opOk = (req, url) => eq(url.searchParams.get("token") || cookieToken(req), OP_TOKEN);

async function handleMcp(req, res) {
  if (!eq(req.headers.authorization, `Bearer ${MCP_TOKEN}`)) return send(res, 401, { jsonrpc: "2.0", error: { code: -32600, message: "unauthorized" } });
  if (req.method === "GET") return send(res, 200, { jsonrpc: "2.0", result: { tools: TOOLS } });
  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }); }
  const id = msg.id ?? null;
  const reply = (obj) => send(res, 200, { jsonrpc: "2.0", ...(id !== null ? { id } : {}), ...obj });
  if (msg.method === "initialize") return reply({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "interview-notes", version: "1.0.0" } } });
  if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) { res.writeHead(202); return res.end(); }
  if (msg.method === "ping") return reply({ result: {} });
  if (msg.method === "tools/list") return reply({ result: { tools: TOOLS } });
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
      const b = JSON.parse(await readBody(req) || "{}");
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
    log({ http: p, ok: false, error: String(e.message || e) });
    return send(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, "127.0.0.1", () => log({ msg: `nuri-phone on 127.0.0.1:${PORT}`, sha: SHA }));
