// Real conversation against the live agent over the ElevenLabs WebSocket, text-only (no audio pricing).
// Executes the real MCP tools (unlike simulate-conversation). Usage: ws-chat.mjs <persona-file-or-name>
import WebSocket from "ws";
const KEY = process.env.ELEVENLABS_API_KEY, A = "agent_8701m4wxab2qfafawfdbfzrranbs";
const H = { "xi-api-key": KEY, "content-type": "application/json" };
const PERSONAS = {
  emin: ["Deutsch bitte.", "Emin Mahrt. M-A-H-R-T.", "Ja klar, schau nach. Ich baue gerade an Passkey-Wallets, in Berlin.", "Ja, das bin ich.", "2013 in Kreuzberg, ein Freund hat mir ein paar Coins geschickt, ich hab sie auf blockchain.info liegen lassen.", "2014 wollte ich ran, Login weg. Alles probiert, am Ende abgeschrieben.", "Hardware-Wallet, Backup im Schließfach. Einmal getestet, danach nie wieder.", "Meine Familie wüsste nicht, wie sie da rankommt. Das ist die Sorge.", "Ich hab es einmal erklärt, zu kompliziert, seitdem schiebe ich es.", "Es müsste ohne Fachbegriffe gehen, Schritt für Schritt.", "Ich muss langsam los.", "Passt so.", "Ja, emin@nuri.com.", "Ja, Name ist ok."],
};
const name = process.argv[2] || "emin";
const script = PERSONAS[name];
const t0 = Date.now(), ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
// patch LLM first, then fetch the signed url (a PATCH invalidates earlier signed urls)
const LLM = process.argv[3];
if (LLM) { const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${A}`, { method: "PATCH", headers: H, body: JSON.stringify({ conversation_config: { agent: { prompt: { llm: LLM } } } }) }); console.log("llm", LLM, r.status); await new Promise((r) => setTimeout(r, 3000)); }
const sig = await (await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${A}`, { headers: H })).json();
const ws = new WebSocket(sig.signed_url);
let i = 0, lastAgent = 0, convId = null, pendingTool = false, sentAt = 0;
const lat = [], ttfb = []; let firstDelta = 0;
function sendNext() {
  if (i >= script.length) { setTimeout(() => ws.close(), 8000); return; }
  const text = script[i++];
  console.log(`${ts()} [user ] ${text}`);
  sentAt = Date.now();
  ws.send(JSON.stringify({ type: "user_message", text }));
}
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "conversation_initiation_client_data", conversation_config_override: { conversation: { text_only: true } } }));
});
let agentBuf = "", idle = null;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "conversation_initiation_metadata") { convId = m.conversation_initiation_metadata_event.conversation_id; console.log(`${ts()} conv ${convId}`); return; }
  if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong", event_id: m.ping_event.event_id })); return; }
  if (m.type === "agent_response") {
    const text = m.agent_response_event.agent_response;
    const d = sentAt ? (Date.now() - sentAt) / 1000 : 0;
    if (sentAt) lat.push(d);
    console.log(`${ts()} [agent] (ttfb ${firstDelta.toFixed(2)} full ${d.toFixed(2)}s) ${text}`); firstDelta = 0;
    sentAt = 0;
    clearTimeout(idle); idle = setTimeout(sendNext, 1500);
    return;
  }
  if (m.type === "mcp_tool_call") { const c = m.mcp_tool_call; console.log(`${ts()} TOOL ${c.tool_name} ${c.state || ""} ${JSON.stringify(c.parameters || "").slice(0, 160)} ${JSON.stringify(c.result || "").slice(0, 400)}`); return; }
  if (m.type === "agent_tool_response" || m.type === "agent_tool_request") { console.log(`${ts()} TOOL ${m.type} ${JSON.stringify(m.agent_tool_response || m.agent_tool_request).slice(0, 300)}`); return; }
  if (m.type === "agent_chat_response_part" && m.text_response_part.type === "delta" && sentAt && !firstDelta) { firstDelta = (Date.now() - sentAt) / 1000; ttfb.push(firstDelta); }
  if (["audio", "user_transcript", "agent_chat_response_part", "mcp_connection_status", "internal_tentative_agent_response", "agent_response_correction", "vad_score"].includes(m.type)) return;
  console.log(`${ts()} ${m.type} ${JSON.stringify(m).slice(0, 200)}`);
});
ws.on("close", () => { const s = [...lat].sort((a, b) => a - b); const t = [...ttfb].sort((a, b) => a - b); console.log(`closed. turns ${lat.length} ttfb median ${t[Math.floor(t.length / 2)]?.toFixed(2)} max ${t.at(-1)?.toFixed(2)} | full median ${s[Math.floor(s.length / 2)]?.toFixed(2)}s max ${s.at(-1)?.toFixed(2)}s conv ${convId}`); process.exit(0); });
ws.on("error", (e) => { console.log("ERR", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); ws.close(); }, 240000);
