# Changelog

## v1.0.0 (2026-10-14)
- MCP server with `interview_note`, `research_person`, `finish_interview` (bearer auth, one JSON log line per tool call).
- Live operator page `/live` with 2 s polling and steering queue.
- Own-words report job (`report.js`): ElevenLabs transcript, router LLM quotes verified verbatim, Resend email to support and participant, personal `/i/:token` page.
- Landing page, `/llms.txt`, `/healthz` with git sha.
- ElevenLabs scripts: register MCP server "Interview notes", create agent "Research Interview v3", simulate conversations.
