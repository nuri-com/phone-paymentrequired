# Rules for agents working in this repo

- Never print, log, commit or paste env values (`/opt/nuri-phone/.env`). Names only.
- Never modify the public hotline agent `agent_9801m4s9a6sqf7a9ekvawt8kk5de` or the phone number `phnum_6301ky252eyjfvrbwjn6rtc23tcs` (never PATCH its assignment).
- Never dial a phone number from scripts here. Outbound test calls are done by a human or the orchestrator.
- Never change the ElevenLabs plan.
- Do not add banking, payment or credential vocabulary to the prompt, agent name or MCP server name (ElevenLabs safety flag, error 3000).
- Read back ElevenLabs config after every write (`mcp_server_ids`, `tts`).
- No dependencies; Node 22 stdlib only.
- Deploy = git pull on the box + `systemctl restart nuri-phone`; prove with `/healthz` sha.
