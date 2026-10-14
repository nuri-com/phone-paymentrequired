// Minimal pages: bright, 17px text, one headline size, flush-left, no boxes.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));

const CSS = `
*{box-sizing:border-box}
html{background:#fff;color:#111}
body{margin:0;padding:32px 20px 64px;max-width:760px;font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-x:hidden;overflow-wrap:anywhere}
h1,h2{font-size:28px;line-height:1.25;font-weight:600;margin:40px 0 12px}
h1{margin-top:0}
p,ul,ol,pre{margin:0 0 14px}
ul,ol{padding-left:22px}
a{color:#0645ad}
code,pre{font:inherit;white-space:pre-wrap}
.muted{color:#666}
textarea,input,button,select{font:inherit;color:inherit;background:#fff;border:0;border-bottom:1px solid #999;padding:6px 0;width:100%;border-radius:0}
button{width:auto;border:0;padding:6px 0;color:#0645ad;cursor:pointer;text-decoration:underline}
`;
const page = (title, body, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

export function landing() {
  return page("Research interview hotline", `
<h1>Research interview hotline</h1>
<p>phone.paymentrequired.com runs voice research interviews by phone. An AI interviewer talks with a person, an operator can follow the call and steer the next question, and after the call the person's own words are mailed as a report.</p>
<h2>How it works</h2>
<ol>
<li>A voice agent calls or answers a participant. It says it is an AI and asks before recording.</li>
<li>After every answer the agent writes a short note to this service. The operator sees the notes live and can type an instruction for the next question.</li>
<li>Only if the participant agrees, the agent may look up their public project page or GitHub profile.</li>
<li>At the end the agent stores optional email and consent choices. A report with short quotes in the person's own words and the full transcript goes to our research inbox, and to the participant if they left an email.</li>
</ol>
<h2>For agents</h2>
<p>MCP endpoint (streamable HTTP, bearer token): <code>https://phone.paymentrequired.com/mcp</code></p>
<ul>
<li><code>interview_note</code> after every answer; returns any operator instruction for the next question.</li>
<li><code>research_person</code> read-only public lookup, only with explicit permission.</li>
<li><code>finish_interview</code> at the end: optional email, name, attribution and lookup consent.</li>
</ul>
<p>Machine summary: <a href="/llms.txt">/llms.txt</a>. Health: <a href="/healthz">/healthz</a>. Source: <a href="https://github.com/nuri-com/phone-paymentrequired">github.com/nuri-com/phone-paymentrequired</a>.</p>
<h2>Privacy</h2>
<p>A phone number and a raw transcript are not anonymous. Your voice, number and anything you say can identify you.</p>
<p>Findings we publish are de-identified. We name you only if you say yes to that.</p>
<p>You can skip any question and end the call at any time. No reward or payment is promised.</p>
<p>Questions: support@nuri.com</p>`);
}

export function llmsTxt() {
  return `# phone.paymentrequired.com

> Research interview hotline. A voice agent interviews a participant; this service records notes per answer, relays live operator instructions, does consent-gated public lookups and mails an own-words report after the call.

## MCP
- Endpoint: https://phone.paymentrequired.com/mcp (streamable HTTP, JSON-RPC 2.0, header Authorization: Bearer <token>)
- interview_note {conversation_id?, person_said, agent_summary?, phase}: call after every answer; returns {operator_instruction, research}
- research_person {name?, company?, url?, handle?}: only after explicit permission; read-only public summary, max 120 words
- finish_interview {conversation_id?, email?, name?, may_attribute, consent_research}: end of interview; triggers the report email

## Privacy
- Phone number and raw transcript are not anonymous.
- Published findings are de-identified; names only with opt-in.
- No rewards are promised.

## Other
- Health: https://phone.paymentrequired.com/healthz
- Source: https://github.com/nuri-com/phone-paymentrequired
- Contact: support@nuri.com
`;
}

export function livePage() {
  const js = `
const $=s=>document.querySelector(s);
const el=(t,txt,cls)=>{const e=document.createElement(t);if(txt!=null)e.textContent=txt;if(cls)e.className=cls;return e;};
let sel=null;
async function load(){
  let d; try{d=await (await fetch('/api/interviews',{credentials:'same-origin'})).json();}catch(e){$('#status').textContent='offline';return;}
  $('#status').textContent='updated '+new Date().toLocaleTimeString()+(d.pending_any?' · queued for next active call: '+d.pending_any:'');
  const list=$('#list');
  if(document.activeElement&&document.activeElement.tagName==='TEXTAREA'&&document.activeElement.value)return; // do not re-render while typing
  const drafts={}; list.querySelectorAll('textarea').forEach(t=>drafts[t.dataset.cid]=t.value);
  list.textContent='';
  for(const iv of d.items){
    const s=el('section');
    s.appendChild(el('h2',(iv.active?'Live: ':iv.finished?'Finished: ':'Idle: ')+iv.conversation_id));
    s.appendChild(el('p',(iv.started||'').replace('T',' ').slice(0,19)+' UTC'+(iv.pending_steer?' · queued: '+iv.pending_steer:''),'muted'));
    for(const l of iv.lines){
      const time=(l.ts||'').slice(11,19)+'  ';
      if(l.type==='turn'){s.appendChild(el('p',time+'Person: '+l.person_said));if(l.agent_summary)s.appendChild(el('p','Agent note: '+l.agent_summary,'muted'));}
      else if(l.type==='research')s.appendChild(el('p',time+'Lookup: '+l.summary,'muted'));
      else if(l.type==='steer_queued')s.appendChild(el('p',time+'You queued: '+l.text,'muted'));
      else if(l.type==='steer_delivered')s.appendChild(el('p',time+'Delivered to agent: '+l.text,'muted'));
      else if(l.type==='finish')s.appendChild(el('p',time+'Finished. Email '+(l.email||'none')+', name '+(l.name||'none')+', may attribute '+l.may_attribute+', lookup consent '+l.consent_research));
      else if(l.type==='report')s.appendChild(el('p',time+'Report mailed: '+(l.resend_ids||[]).join(', '),'muted'));
      else if(l.type==='report_error')s.appendChild(el('p',time+'Report failed: '+l.error));
    }
    if(!iv.finished){
      const ta=el('textarea');ta.rows=2;ta.placeholder='Steer the next question';ta.dataset.cid=iv.conversation_id;ta.value=drafts[iv.conversation_id]||'';
      const b=el('button','Send to next question');b.onclick=()=>steer(iv.conversation_id,ta);
      s.appendChild(ta);s.appendChild(b);
    }
    list.appendChild(s);
  }
  if(!d.items.length)list.appendChild(el('p','No interviews yet.','muted'));
}
async function steer(cid,ta){
  const text=ta.value.trim(); if(!text)return;
  const r=await fetch('/api/steer',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({conversation_id:cid,text})});
  if(r.ok){ta.value='';load();}else{$('#status').textContent='steer failed '+r.status;}
}
$('#anysend').onclick=()=>steer('*',$('#any'));
if(location.search.includes('token='))history.replaceState(null,'','/live');
load();setInterval(load,2000);`;
  return page("Live interviews", `
<h1>Live interviews</h1>
<p id="status" class="muted">loading</p>
<p>Instruction for the next call that starts (used by the first interview note of any interview):</p>
<textarea id="any" rows="2" placeholder="e.g. Ask about their last swap first"></textarea>
<button id="anysend">Queue for next active call</button>
<div id="list"></div>`, js);
}

export function personalPage(iv) {
  const tr = iv.lines.find((l) => l.type === "transcript");
  const turns = tr ? tr.turns.map((t) => ({ who: t.role === "agent" ? "Interviewer" : "You", text: t.message }))
    : iv.lines.filter((l) => l.type === "turn").map((l) => ({ who: "You", text: l.person_said }));
  const date = (iv.started || "").slice(0, 10);
  return page("Your interview", `
<h1>Your interview</h1>
<p class="muted">${esc(date)}. This page is only reachable with your personal link.</p>
${turns.map((t) => `<p><strong>${esc(t.who)}:</strong> ${esc(t.text)}</p>`).join("\n")}
<p class="muted">${tr ? "Full transcript from the call." : "Notes taken during the call. The full transcript follows once processing is complete."}</p>
<p class="muted">Want something removed or corrected? Reply to the email or write to support@nuri.com.</p>`);
}
