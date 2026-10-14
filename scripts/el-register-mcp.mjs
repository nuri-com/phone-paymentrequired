// Register (or reuse) the "Interview notes" MCP server in ElevenLabs, auto-approve, read back tools.
// Run on the box: cd /opt/nuri-phone && node --env-file=.env scripts/el-register-mcp.mjs [--url https://support.nuri.com/phone-mcp]
import { writeFileSync, readFileSync, existsSync } from "node:fs";
const API = "https://api.elevenlabs.io/v1/convai";
const KEY = process.env.ELEVENLABS_API_KEY, TOKEN = process.env.PHONE_MCP_TOKEN;
if (!KEY || !TOKEN) throw new Error("ELEVENLABS_API_KEY and PHONE_MCP_TOKEN required");
const a = process.argv.slice(2);
const url = a.includes("--url") ? a[a.indexOf("--url") + 1] : "https://phone.paymentrequired.com/mcp";
const OUT = new URL("../data/el-mcp-server.json", import.meta.url).pathname;
async function req(path, method = "GET", body) {
  const r = await fetch(API + path, { method, headers: { "xi-api-key": KEY, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify({ path, status: r.status, body: j }));
  return j;
}
let id = existsSync(OUT) && !a.includes("--new") ? JSON.parse(readFileSync(OUT, "utf8")).id : null;
if (id && JSON.parse(readFileSync(OUT, "utf8")).url !== url) id = null;
if (!id) {
  const created = await req("/mcp-servers", "POST", { config: {
    name: "Interview notes",
    description: "Notes and follow-up hints for a research conversation.",
    transport: "STREAMABLE_HTTP", url, approval_policy: "auto_approve_all",
    request_headers: { Authorization: `Bearer ${TOKEN}` },
  } });
  id = created.id;
  writeFileSync(OUT, JSON.stringify({ id, url, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
}
await req(`/mcp-servers/${id}/approval-policy`, "PATCH", { approval_policy: "auto_approve_all" });
const s = await req(`/mcp-servers/${id}`);
const tools = await req(`/mcp-servers/${id}/tools`);
console.log(JSON.stringify({ mcp_server_id: id, name: s.config?.name, url: s.config?.url, approval_policy: s.config?.approval_policy, tools: (tools.tools || []).map((t) => t.name) }, null, 2));
