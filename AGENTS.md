# AGENTS.md

Operating rules for AI coding agents in **sprechstunde**. Human overview, setup and the
latency/robustness details: [README.md](README.md).

## What it is

A voice assistant for small businesses' phone lines (opening hours, directions, hand-over to a
person), built on LiveKit Agents (Node 24, TypeScript, ESM) with a Mistral STT/LLM/TTS cascade.
Apache-2.0, **public repo**. Status: spike — no real call has gone through yet (README, "Not
tested yet"; keep that list honest when you change behaviour).

## Layout

|`src/core/` |channel-independent: profile loading (`profile.ts`), prompt (`prompt.ts`), tools
(`tools.ts`), audio helpers. Knows nothing about phones, LiveKit or SIP
|`src/agent/` |LiveKit wiring: `main.ts` (worker entry), `assistant.ts`, `transfer.ts`, STT guard /
merge, hedged TTS, `metrics.ts`. Tests sit next to the file as `*.test.ts`
|`src/cli/` |dev tools run via npm scripts: `provision`, `tts:try`, `stt:try`, `voice`
|`src/i18n.ts` |gettext lookup; catalogues in `po/` (`de.po`, `sprechstunde.pot`)
|`deploy/` |`livekit.yaml`, `sip.yaml`, `asterisk/` (provider leg: Asterisk registers with the SIP
provider, `livekit/sip` cannot)
|`compose.yaml` |local stack (Valkey, LiveKit, SIP, Asterisk, optional agent), host networking
|`profiles/example/` |the only profile in the repo: a made-up venue
|`dev/` |shell/bench helpers (`browser-call.sh`, `i18n.sh`, `record-voice.sh`, …)
|`.werkstatt-state.json` |declares the gitignored local files (`.env`, `node_modules`, `dist`,
`var`, `console-recordings`) and how to recreate them

## Commands

```sh
npm ci && npm run download-files   # after EVERY npm ci: part of the turn-detector model lives in node_modules
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
npm run i18n:extract && npm run i18n:compile     # needs gettext; English msgids, German in po/de.po
npm run agent:dev          # agent worker, needs .env and the compose stack (`npm run stack:up`)
npm run agent:dev:prof     # same with CPU profiling (SPRECHSTUNDE_CPU_PROF=1)
bash dev/browser-call.sh   # call the running agent from the browser, no phone line; new room per run
```

**All of typecheck, lint, format:check, test and build must be green before every commit** —
that is exactly what `.github/workflows/ci.yml` runs (Node 24, gettext installed). `npm run
format` fixes formatting (oxfmt).

## Rules

|**core stays channel-independent**: nothing under `src/core/` imports LiveKit or knows about
telephony; channel specifics go in `src/agent/`
|**privacy**: transcripts and caller numbers are never stored. Metrics (`var/metrics/<date>.jsonl`)
are numbers, ids and timestamps only — never add text content to them or to logs
|**secrets** only in the gitignored `.env` (template: `.env.example`); never read it into output,
commits, issues or PR text
|**public repo**: only the fictitious example profile belongs here (its transfer target is invalid
on purpose). Real venue profiles live outside this repository; no real names, numbers, voice IDs
or recordings in code, docs, tests, fixtures or commit messages. `profile.timeZone` is required;
`loadProfile` refuses an empty greeting (it must disclose the AI, EU AI Act Art. 50)
|**i18n**: every user-facing string goes through gettext with English msgids; German lives in
`po/de.po` and must have 0 untranslated entries. Run extract + compile after touching strings
|**tests must not need network or API keys**: use fakes (see the stt-guard / tts-hedge tests);
real-service behaviour goes into README "Not tested yet", not into CI
|**long-running processes** (`agent:dev`, `stack:up`, `stack:logs`) run in the background, never
in a foreground call that blocks
|**upstream bugs**: a consumer-side shim for a bug in a dependency (LiveKit, Mistral SDK, …)
carries a code comment naming the upstream issue/condition so it can be removed later, plus an
issue in THIS repo titled `Upstream (<project>, file by hand): …` with the facts. Never file
issues, comments or PRs at third-party projects; the maintainer files by hand
|latency and robustness design (stall guard, batch fallback, hedged TTS, frame merging): read
README "Latency and robustness" before changing `src/agent/` timing code

## Commits

Atomic; each leaves the repo green. Conventional `<type>[scope]: <description>`, imperative,
subject ≤ 50 chars. No `--no-verify`. Check `git log --oneline -10` for style.
