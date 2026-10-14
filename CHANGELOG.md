# Changelog

## v1.1.0 (2026-10-14)
- Security review fixes: SSRF guard for `research_person` (DNS check per hop, pinned address, manual redirects, ports 80/443, 512 KB cap), server-side `consent: true`, strict `conv_` ids (no fallback, no account-wide mapping in `report.js`), 413 on large bodies, 400 on bad steer JSON, security headers, systemd unit runs as `nuri-phone` with sandboxing.

## v1.0.1 (2026-10-14)
- Prompt: finish_interview must come before end_call. Simulations still end after the email question (simulate-conversation does not execute MCP tools); verify on a real call.
- Report: localized contact labels.

## v1.0.0 (2026-10-14)
- MCP server with `interview_note`, `research_person`, `finish_interview` (bearer auth, one JSON log line per tool call).
- Live operator page `/live` with 2 s polling and steering queue.
- Own-words report job (`report.js`): ElevenLabs transcript, router LLM quotes verified verbatim, Resend email to support and participant, personal `/i/:token` page.
- Landing page, `/llms.txt`, `/healthz` with git sha.
- ElevenLabs scripts: register MCP server "Interview notes", create agent "Research Interview v3", simulate conversations.
