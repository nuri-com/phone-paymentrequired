// Create "Research Interview v3": clone conversation_config of the test interviewer agent,
// swap prompt + first message, attach only our MCP server. Never touches phone numbers or the hotline agent.
// Run on the box: cd /opt/nuri-phone && node --env-file=.env scripts/el-create-agent.mjs [--new]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const API = "https://api.elevenlabs.io/v1/convai";
const KEY = process.env.ELEVENLABS_API_KEY;
const SOURCE = "agent_2901m4wh3m7new29kfegg5nznm5j";
const FORBIDDEN = "agent_9801m4s9a6sqf7a9ekvawt8kk5de"; // public hotline: never modify
const root = new URL("..", import.meta.url).pathname;
const OUT = root + "data/el-agent.json";
const mcp = JSON.parse(readFileSync(root + "data/el-mcp-server.json", "utf8")).id;
const prompt = readFileSync(root + "prompt/interview-prompt.txt", "utf8");
const FIRST = "Hi, I'm Nuri's AI research interviewer. This call is recorded and transcribed. Is now a good time?";
async function req(path, method = "GET", body) {
  const r = await fetch(API + path, { method, headers: { "xi-api-key": KEY, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(JSON.stringify({ path, status: r.status, body: j }));
  return j;
}
const src = await req(`/agents/${SOURCE}`);
const c = structuredClone(src.conversation_config);
c.agent.prompt.prompt = prompt;
c.agent.first_message = FIRST;
c.agent.language = "en";
c.agent.prompt.mcp_server_ids = [mcp];
c.agent.prompt.tool_ids = [];
let id = existsSync(OUT) && !process.argv.includes("--new") ? JSON.parse(readFileSync(OUT, "utf8")).agent_id : null;
if (id === FORBIDDEN || id === SOURCE) throw new Error("refusing to modify " + id);
if (!id) {
  const created = await req("/agents/create", "POST", { name: "Research Interview v3", conversation_config: c, platform_settings: src.platform_settings ? { data_collection: src.platform_settings.data_collection } : undefined });
  id = created.agent_id;
  writeFileSync(OUT, JSON.stringify({ agent_id: id, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
} else {
  await req(`/agents/${id}`, "PATCH", { conversation_config: c });
}
const a = await req(`/agents/${id}`);
const fc = a.conversation_config;
const out = {
  agent_id: a.agent_id, name: a.name,
  mcp_server_ids: fc.agent.prompt.mcp_server_ids,
  llm: fc.agent.prompt.llm,
  tts: { voice_id: fc.tts.voice_id, model_id: fc.tts.model_id, speed: fc.tts.speed },
  turn_eagerness: fc.turn.turn_eagerness,
  first_message: fc.agent.first_message,
  prompt_matches_file: fc.agent.prompt.prompt === prompt,
  knowledge_base_docs: (fc.agent.prompt.knowledge_base || []).length,
  voice_same_as_source: fc.tts.voice_id === src.conversation_config.tts.voice_id && fc.tts.model_id === src.conversation_config.tts.model_id && fc.tts.speed === src.conversation_config.tts.speed,
};
console.log(JSON.stringify(out, null, 2));
if (JSON.stringify(out.mcp_server_ids) !== JSON.stringify([mcp]) || !out.prompt_matches_file || !out.voice_same_as_source) { console.error("READBACK MISMATCH"); process.exit(1); }
