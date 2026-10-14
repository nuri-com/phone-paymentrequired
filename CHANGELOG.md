# Changelog

## 2026-10-14 — [RELEASE] v1.1.1 — hermes-agent for emino
- State at main HEAD `a3655574`: MCP server (`interview_note`, `research_person`, `finish_interview`), live operator page, own-words report job, ElevenLabs scripts, sandboxed systemd deploy behind Caddy at phone.paymentrequired.com.
- `a3655574` deploy: systemd ExecStart uses a node hard link under `/usr/local/lib/nuri-phone`, so the `nuri-phone` user can exec node outside `/root`.
- `61cd874c` security fixes released as v1.1.0 (see below).
- Docs: README gets Logs, Status, Architecture, User flow, Components, Run sections; PROMPTLOG.md added. No code changed.

## Commit history (2026-10-14)
- `a3655574` systemd unit runs node from a hard link outside /root (#2).
- `61cd874c` SSRF guard, server-side consent, strict conv ids, 413, security headers, systemd user (#1).
- `bcefd344` changelog for v1.0.1.
- `22cbf605` evidence: second simulate run after the end_call ordering rule.
- `a330ed7d` prompt: finish_interview must come before end_call.
- `a82dd879` evidence: two simulate-conversation runs (EN founder, DE user).
- `dadcaf4f` report: localized contact labels.
- `27af8bc9` first commit: interview MCP, live page, own-words report, ElevenLabs scripts.

## v1.1.0 (2026-10-14) — `61cd874c`
- Security review fixes: SSRF guard for `research_person` (DNS check per hop, pinned address, manual redirects, ports 80/443, 512 KB cap), server-side `consent: true`, strict `conv_` ids (no fallback, no account-wide mapping in `report.js`), 413 on large bodies, 400 on bad steer JSON, security headers, systemd unit runs as `nuri-phone` with sandboxing.

## v1.0.1 (2026-10-14) — `bcefd344`
- Prompt: finish_interview must come before end_call. Simulations still end after the email question (simulate-conversation does not execute MCP tools); verify on a real call.
- Report: localized contact labels.

## v1.0.0 (2026-10-14) — `27af8bc9`
- MCP server with `interview_note`, `research_person`, `finish_interview` (bearer auth, one JSON log line per tool call).
- Live operator page `/live` with 2 s polling and steering queue.
- Own-words report job (`report.js`): ElevenLabs transcript, router LLM quotes verified verbatim, Resend email to support and participant, personal `/i/:token` page.
- Landing page, `/llms.txt`, `/healthz` with git sha.
- ElevenLabs scripts: register MCP server "Interview notes", create agent "Research Interview v3", simulate conversations.
