// One-off: research_person async (does not block the turn), finish_interview immediate; eager turn + speculative_turn.
// Run from a dir with ELEVENLABS_API_KEY in .env: node --env-file=.env scripts/el-tool-modes.mjs
const KEY=process.env.ELEVENLABS_API_KEY,H={"xi-api-key":KEY,"content-type":"application/json"},M="weOHoEUVXLsNfjgQ6ybs",A="agent_8701m4wxab2qfafawfdbfzrranbs";
const f=async(u,o)=>{const r=await fetch("https://api.elevenlabs.io/v1/convai"+u,{headers:H,...o});const t=await r.text();return [r.status,t];};
// server-level: speak before tools, tools run async by default; finish_interview immediate
console.log("server",...(await f(`/mcp-servers/${M}`,{method:"PATCH",body:JSON.stringify({pre_tool_speech:"off",execution_mode:"async",response_timeout_secs:20})})).map(x=>String(x).slice(0,200)));
for (const [name,cfg] of [["research_person",{execution_mode:"async",pre_tool_speech:"off",response_timeout_secs:20}],["finish_interview",{execution_mode:"immediate",pre_tool_speech:"off",response_timeout_secs:20}]]) {
  let [s,t]=await f(`/mcp-servers/${M}/tool-configs/${name}`,{method:"PATCH",body:JSON.stringify(cfg)});
  if (s===404) [s,t]=await f(`/mcp-servers/${M}/tool-configs`,{method:"POST",body:JSON.stringify({tool_name:name,...cfg})});
  console.log(name,s,t.slice(0,200));
}
const [s2,t2]=await f(`/mcp-servers/${M}`);const c=JSON.parse(t2).config;console.log("readback",c.execution_mode,c.pre_tool_speech,JSON.stringify(c.tool_config_overrides).slice(0,400));
// turn: speculative + eager, timeout 4
const [s3,t3]=await f(`/agents/${A}`,{method:"PATCH",body:JSON.stringify({conversation_config:{turn:{turn_eagerness:"eager",speculative_turn:true,turn_timeout:4,spelling_patience:"auto"}}})});
const a=JSON.parse(t3);console.log("turn",s3,JSON.stringify(a.conversation_config.turn));