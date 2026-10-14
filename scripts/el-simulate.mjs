// Text-only simulated interviews (no telephony, MCP tools are NOT executed by ElevenLabs here).
// Run on the box: cd /opt/nuri-phone && node --env-file=.env scripts/el-simulate.mjs <agent_id> <outdir>
import { writeFileSync, mkdirSync } from "node:fs";
const [agent, outdir = "evidence"] = process.argv.slice(2);
if (!agent) throw new Error("usage: el-simulate.mjs <agent_id> [outdir]");
mkdirSync(outdir, { recursive: true });
const personas = {
  "sim-en-founder": "You are Priya, founder of a small startup in Lisbon that builds a bitcoin payments plugin for online shops. Speak English. You are busy but friendly. You keep company funds on an exchange plus a hardware wallet the CTO holds; last month a payout got stuck for two days because the CTO was on holiday. Answer in 1 to 3 sentences. If asked to be looked up online, say yes, your site is example-pay.io. At the end leave the email priya@example.com and say they may not use your name. Say goodbye when the interviewer closes.",
  "sim-de-user": "Du bist Jonas, 34, Pfleger aus Leipzig. Sprich nur Deutsch. Du hast vor drei Jahren Bitcoin über eine App gekauft, die Wörter für das Backup stehen auf einem Zettel in deiner Schublade. Einmal hast du an die falsche Adresse geschickt, 50 Euro weg. Antworte kurz, in 1 bis 2 Sätzen, umgangssprachlich. Online nachschauen lehnst du ab. Keine E-Mail, Name darf nicht genannt werden. Verabschiede dich, wenn der Interviewer abschließt.",
};
for (const [name, prompt] of Object.entries(personas)) {
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agent}/simulate-conversation`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ simulation_specification: { simulated_user_config: { prompt: { prompt }, language: name.includes("-de-") ? "de" : "en" } }, new_turns_limit: 40 }),
    signal: AbortSignal.timeout(280000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(name, r.status, JSON.stringify(j).slice(0, 600)); continue; }
  const turns = (j.simulated_conversation || []).filter((t) => t.message || t.tool_calls?.length);
  const md = [`# ${name}`, "", `agent: ${agent}, simulated ${new Date().toISOString()}, turns: ${turns.length}`, "Note: simulate-conversation does not execute MCP tools; tool calls appear as intents only.", "",
    ...turns.map((t) => `**${t.role === "agent" ? "Interviewer" : "Participant"}:** ${t.message || ""}${t.tool_calls?.length ? `  _(tool: ${t.tool_calls.map((c) => c.tool_name).join(", ")})_` : ""}`)].join("\n\n");
  writeFileSync(`${outdir}/${name}.md`, md + "\n");
  const agentTurns = turns.filter((t) => t.role === "agent" && t.message);
  const wc = agentTurns.map((t) => t.message.split(/\s+/).length).sort((a, b) => a - b);
  console.log(JSON.stringify({ name, turns: turns.length, tool_calls: turns.flatMap((t) => (t.tool_calls || []).map((c) => c.tool_name)), agent_words_median: wc[Math.floor(wc.length / 2)], agent_words_max: wc.at(-1) }));
}
