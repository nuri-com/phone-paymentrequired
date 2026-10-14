// Own-words interview report: fetch ElevenLabs transcript, extract quotes with the router LLM,
// keep only quotes that literally occur in what the participant said, email via Resend.
// CLI: node --env-file=.env report.js <conversation_id> [--to addr] [--print] [--force]
import { append, readInterview, llm, sendMail, validEmail, newToken } from "./lib.js";

const EL = "https://api.elevenlabs.io/v1/convai";
const SUPPORT = process.env.REPORT_TO || "support@nuri.com";
const BASE_URL = process.env.PUBLIC_BASE_URL || "https://phone.paymentrequired.com";
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
const elGet = async (path) => {
  const r = await fetch(EL + path, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`elevenlabs ${path} HTTP ${r.status}`);
  return r.json();
};

export async function fetchConversation(id, { maxWaitMs = 180000 } = {}) {
  const until = Date.now() + maxWaitMs;
  for (;;) {
    const c = await elGet(`/conversations/${encodeURIComponent(id)}`);
    if ((c.status === "done" || c.status === "failed") && Array.isArray(c.transcript)) return c;
    if (Date.now() > until) throw new Error(`conversation ${id} not done after wait (status ${c.status})`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const norm = (s) => String(s).toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const noEmDash = (s) => String(s).replace(/\u2014/g, ",").replace(/ ,/g, ",");

export async function buildReport(cid, { conv, interview } = {}) {
  const turns = (conv.transcript || []).filter((t) => t.message);
  const transcript = turns.map((t) => `${t.role === "agent" ? "Interviewer" : "Participant"}: ${t.message}`).join("\n");
  const said = norm(turns.filter((t) => t.role === "user").map((t) => t.message).join(" \n "));
  const fin = interview?.finish || {};

  const sys = `You extract an own-words research report from an interview transcript. Output JSON only, no prose, with keys:
language ("de" or "en": the language the participant mostly spoke),
first_name (string or null: only if the participant stated their own name),
email_stated (string or null: only if the participant stated an email),
attribution_stated (true, false or null: only if the participant answered whether they may be named),
themes: array of 3 to 6 objects {theme: short label in that language, quotes: array of exact substrings copied character for character from Participant lines}, 5 to 10 quotes in total, each 3 to 30 words,
who: array of 1 to 5 short sentences in that language on what the participant does or who they are, using only what they said; empty if they said nothing about it.
Rules: quotes must be verbatim from Participant lines, never from Interviewer lines; no interpretation; no invented facts; never use the em dash character.`;
  const { text, model } = await llm([{ role: "system", content: sys }, { role: "user", content: transcript.slice(0, 120000) }]);
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

  let kept = 0, dropped = 0;
  const themes = (json.themes || []).map((th) => ({
    theme: noEmDash(th.theme),
    quotes: (th.quotes || []).filter((q) => { const ok = norm(q).length > 0 && said.includes(norm(q)); ok ? kept++ : dropped++; return ok; }).map(noEmDash),
  })).filter((th) => th.quotes.length);

  const de = json.language === "de";
  const firstName = (fin.name ? String(fin.name).trim().split(/\s+/)[0] : json.first_name) || (de ? "anonym" : "anonymous");
  const date = new Date((conv.metadata?.start_time_unix_secs || Date.now() / 1000) * 1000).toISOString().slice(0, 10);
  const dur = conv.metadata?.call_duration_secs;
  const L = de
    ? { said: "WAS DIE PERSON GESAGT HAT, IN IHREN WORTEN", who: "WER SIE IST, NACH IHREN EIGENEN ANGABEN", none: "Dazu hat die Person nichts gesagt.", contact: "KONTAKT UND EINWILLIGUNG", full: "VOLLSTÄNDIGES TRANSKRIPT", yes: "ja", no: "nein", unk: "nicht gefragt oder nicht beantwortet", name: "Name", email: "E-Mail", attr: "Namensnennung erlaubt", look: "Online-Recherche erlaubt", src: "Quelle der Angaben", srcTool: "finish_interview", srcTr: "nur Transkript (kein finish_interview)" }
    : { said: "WHAT THE PERSON SAID, IN THEIR OWN WORDS", who: "WHO THEY ARE, IN THEIR OWN WORDS", none: "The person said nothing about this.", contact: "CONTACT AND CONSENT", full: "FULL TRANSCRIPT", yes: "yes", no: "no", unk: "not asked or not answered", name: "Name", email: "Email", attr: "May attribute by name", look: "Consented to public lookup", src: "Source of flags", srcTool: "finish_interview tool", srcTr: "transcript only (no finish_interview call)" };
  const yn = (v) => (v === true ? L.yes : v === false ? L.no : L.unk);
  const email = fin.email || json.email_stated || null;
  const body = [
    `Conversation: ${conv.conversation_id || cid}`,
    `Date: ${date}${dur ? `, ${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")} min` : ""}`,
    "",
    L.said,
    "",
    ...themes.flatMap((th) => [th.theme, ...th.quotes.map((q) => `"${q}"`), ""]),
    L.who,
    ...((json.who || []).length ? json.who.map((w) => noEmDash(w)) : [L.none]),
    "",
    L.contact,
    `${L.name}: ${fin.name || json.first_name || L.unk}`,
    `${L.email}: ${email || L.unk}`,
    `${L.attr}: ${yn(fin.may_attribute ?? json.attribution_stated)}`,
    `${L.look}: ${yn(fin.consent_research)}`,
    `${L.src}: ${interview?.finish ? L.srcTool : L.srcTr}`,
    "",
    L.full,
    transcript,
    "",
    `Report model: ${model}. Quotes kept ${kept}, dropped as not verbatim ${dropped}.`,
  ].join("\n");
  return { subject: `Interview: ${firstName} \u2013 ${date}`, body, kept, dropped, model, email, de };
}

export async function runReport(cid, { to = null, print = false, force = false } = {}) {
  if (!/^conv_[a-z0-9]+$/.test(String(cid))) throw new Error("not an ElevenLabs conversation id (conv_...): " + cid);
  const interview = readInterview(cid);
  const realId = cid;
  const conv = await fetchConversation(realId);
  const r = await buildReport(cid, { conv, interview });
  if (interview && !interview.lines.some((l) => l.type === "transcript")) {
    append(cid, { type: "transcript", el_conversation_id: realId, turns: (conv.transcript || []).filter((t) => t.message).map((t) => ({ role: t.role, message: t.message })) });
  }
  if (print) { console.log(r.subject + "\n\n" + r.body); return { printed: true }; }
  const suffix = force ? "-" + Date.now() : "";
  const sent = [];
  const recipients = to ? [to] : [SUPPORT];
  for (const rcpt of recipients) {
    const m = await sendMail({ to: rcpt, subject: r.subject, text: r.body, idempotencyKey: `phone-report-${realId}-${rcpt}${suffix}` });
    sent.push(m); log({ job: "report", conversation_id: realId, to: rcpt, resend_id: m.id, kept: r.kept, dropped: r.dropped });
  }
  const pEmail = interview?.finish?.email;
  if (!to && validEmail(pEmail) && interview.finish.personal_token) {
    const link = `${BASE_URL}/i/${interview.finish.personal_token}`;
    const intro = r.de
      ? `Danke für das Gespräch. Hier ist dein eigenes Interview:\n${link}\n\nUnten steht, was du gesagt hast, in deinen Worten, und das vollständige Transkript.\n\n`
      : `Thank you for the conversation. Here is your own interview:\n${link}\n\nBelow is what you said, in your own words, and the full transcript.\n\n`;
    const m = await sendMail({ to: pEmail, subject: r.subject, text: intro + r.body, idempotencyKey: `phone-report-${realId}-participant${suffix}` });
    sent.push(m); log({ job: "report", conversation_id: realId, to: "participant", resend_id: m.id });
  }
  append(cid, { type: "report", el_conversation_id: realId, resend_ids: sent.map((s) => s.id), kept: r.kept, dropped: r.dropped, model: r.model });
  return { conversation_id: realId, resend_ids: sent.map((s) => s.id), subject: r.subject, kept: r.kept, dropped: r.dropped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const cid = a.find((x) => !x.startsWith("--") && a[a.indexOf(x) - 1] !== "--to");
  const to = a.includes("--to") ? a[a.indexOf("--to") + 1] : null;
  if (!cid) { console.error("usage: node --env-file=.env report.js <conversation_id> [--to addr] [--print] [--force]"); process.exit(2); }
  runReport(cid, { to, print: a.includes("--print"), force: a.includes("--force") })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => { console.error(String(e.stack || e)); process.exit(1); });
}
export { newToken };
