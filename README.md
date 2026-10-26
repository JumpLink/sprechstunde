# sprechstunde

A voice assistant for small businesses' phone lines — opening hours, directions, "can I bring my
dog", and a hand-over to a person when it cannot help. Built on
[LiveKit Agents](https://github.com/livekit/agents-js) (Node, TypeScript).

The core (`src/core/`) knows nothing about phones: it loads a **profile** (who the assistant
speaks for, its facts, where to transfer) and builds the prompt and tools. The phone is the first
channel; a browser channel can reuse the same core.

Status: **spike**. The audio path, the Mistral cascade and the transfer are typechecked and the
local stack starts, but no real call has gone through yet.

## How a call flows

```
provider (SIP/TLS) → Asterisk (REGISTER) → livekit/sip → livekit-server (+ Valkey) → agent
```

Asterisk is there because `livekit/sip` cannot register with a provider itself. `livekit/sip` keeps
a call ringing until an agent subscribes to its audio, about 2 s when one runs. If none does
within `SPRECHSTUNDE_ANSWER_TIMEOUT` seconds (default 10), Asterisk answers and plays the profile's
`fallback` text. `npm run fallback` records that text into `deploy/asterisk/sounds/fallback.wav`
with the same Mistral voice as the agent; without the file Asterisk plays its English "no service"
prompt.

## Quick start (local)

Needs Node ≥ 22, Podman with `podman compose`, and gettext for the catalogues.

```sh
npm ci
cp .env.example .env          # fill in the LiveKit secret first; the rest can wait
npm run stack:up              # valkey, livekit-server, livekit/sip, asterisk (creates the var/ bind-mount dirs first: podman fails on missing ones)
npm run provision             # inbound trunk + dispatch rule, idempotent; Valkey keeps them in var/valkey across restarts
SPRECHSTUNDE_MODE=echo npm run agent:dev
```

`SPRECHSTUNDE_MODE=echo` needs no AI key: the agent plays back what it hears, which tests the
audio path end to end. `assistant` (the default) needs `MISTRAL_API_KEY`.

Before the first `assistant` run, and again after every `npm ci`, download the turn-detector model:
`npm run download-files`. Part of it (the tokenizer) lands inside `node_modules`, so a clean
install deletes it and the agent then fails at start with "Required model files not found locally".

Asterisk unregisters from the provider when its container stops. A registrar that holds contacts
long and allows only a few (1&1: about two hours) still fills up after a crash or a `kill`;
`npm run sip:contacts` shows how many contacts it holds for the number, `npm run sip:contacts --
clear` removes them all. Both print status lines and counts only.

### Without a phone or a LiveKit server

The [LiveKit CLI](https://github.com/livekit/livekit-cli) runs the agent in-process, no stack
needed (the transfer tool then reports that it only works on phone calls):

```sh
npm run build
set -a; . ./.env; set +a      # lk passes no --env-file to node
lk agent console dist/agent/main.js            # talk through microphone and speakers
lk agent console --text dist/agent/main.js     # type instead; only the LLM runs
lk agent debugger start dist/agent/main.js     # scripted turns: `lk agent debugger say "…"`
```

To test by voice in the browser, start a local LiveKit server and the agent, then open a call:

```sh
podman compose up -d redis livekit
npm run agent:dev                # in another terminal or in the background
dev/browser-call.sh              # new room and token on every run, opens meet.livekit.io
```

Every run uses a fresh room because LiveKit dispatches the agent only when a room is created.
Reloading the browser page does not start a new call: the agent leaves on hang-up and LiveKit
dispatches only on room creation, so run `dev/browser-call.sh` again.

To find out where the event loop or CPU time goes, start the agent with `npm run agent:dev:prof`
(same as `SPRECHSTUNDE_CPU_PROF=1`). It writes a V8 CPU profile to `var/prof/<jobId>.cpuprofile`
when the session closes. Off by default.
`lk agent console` with voice crashed on one Linux setup here (its statically linked ALSA build
could not reach PipeWire); that is an observation on one machine, not a general limit.

## Configuration

| Variable | Meaning |
|---|---|
| `SPRECHSTUNDE_PROFILE` | path to the profile JSON, default `profiles/example/profile.de.json` |
| `SPRECHSTUNDE_MODE` | `assistant` or `echo` |
| `SPRECHSTUNDE_AGENT_NAME` | name used for explicit dispatch, default `sprechstunde` |
| `SPRECHSTUNDE_STT_MODEL` / `_LLM_MODEL` / `_TTS_MODEL` | override the Mistral models |
| `SPRECHSTUNDE_LLM_FALLBACK_MODEL` | optional second LLM, asked when the first is too slow or fails. Empty (the default) leaves the single model in place |
| `SPRECHSTUNDE_LLM_ATTEMPT_TIMEOUT` | seconds one LLM gets before the fallback is asked, default `3`. Only used with a fallback model |
| `SPRECHSTUNDE_TTS_PROVIDER` | `mistral` (default), `cartesia` (needs `CARTESIA_API_KEY`, model default `sonic-3.6`), `openrouter` (needs `OPENROUTER_API_KEY` and `SPRECHSTUNDE_TTS_MODEL`, e.g. `elevenlabs/eleven-flash-v2.5`), `pocket` (Kyutai Pocket TTS on this machine, see [Local voice](#local-voice-kyutai-pocket-tts)) or `kugel` (KugelAudio, needs `KUGELAUDIO_API_KEY`, model default `kugel-3.5`). OpenRouter is for comparing voices: it routes to vendors outside the EU |
| `SPRECHSTUNDE_TTS_VOICE` | override the profile's TTS voice. A voice id belongs to one vendor, so for `cartesia`, `openrouter` and `kugel` it is required and the profile's voice is ignored; `pocket` defaults to the server's voice. A `kugel` voice id is a number from that vendor's library |
| `KUGELAUDIO_API_KEY` / `SPRECHSTUNDE_KUGEL_REGION` | the KugelAudio key, and which endpoint it is used against: `eu` (default) sends the key with the `eu-` prefix that selects the EU endpoint, `global` leaves the vendor's geo-routing in charge. A key that already carries a region prefix keeps it. The call's language comes from the profile locale (`de-DE` → `de`), which is what makes the vendor read numbers, times and dates as German — so, unlike Pocket, this provider gets the text unchanged |
| `SPRECHSTUNDE_TTS_NAME` | the name the assistant uses with this voice. Every whole-word mention of the profile's `assistantName` in the greeting, the instructions and the transfer announcement becomes this name |
| `SPRECHSTUNDE_TTS_FALLBACK_PROVIDER` / `_MODEL` / `_VOICE` / `_REF_AUDIO` / `_NAME` | optional second voice, same meaning as above. It steps in when the first voice fails mid-call and takes whole calls when the Pocket server has no free session |
| `POCKET_TTS_URL` | the Pocket server, default `http://127.0.0.1:8090` |
| `SPRECHSTUNDE_TTS_REF_AUDIO` | path to an audio file to clone; overrides every other voice setting |
| `SIP_LINES` | comma-separated line ids (`[a-z0-9-]{1,20}`), one provider registration each; unset means the one line `main` from `SIP_PROVIDER_*`. Per line `SIP_LINE_<ID>_USER`, `_PASSWORD`, `_NUMBER` and optionally `_HOST`, `_DOMAIN`, `_MEDIA_ENCRYPTION` (ID uppercased, `-` as `_`); each defaults to the `SIP_PROVIDER_*` value. The admin Knowledge page assigns a profile per line (`lines` in the settings file); unassigned lines use the picked profile. A transfer goes out via the line the call came in on; the allowed target is still `TRANSFER_TARGET_NUMBER` |
| `SPRECHSTUNDE_TRUNK_NUMBERS` | comma-separated numbers for the inbound trunk; empty accepts any |
| `SPRECHSTUNDE_METRICS_DIR` | where latency metrics are written, default `var/metrics` |
| `SPRECHSTUNDE_PROFILES_DIR` | where the [settings UI](#settings-ui) looks for profiles it may pick per call, default `var/profiles` (mounted read-only into the containers). The settings file names one by file name (`*.json`), never by path; the agent reads it at the start of a call and falls back to `SPRECHSTUNDE_PROFILE` when the file is missing or invalid |
| `SPRECHSTUNDE_SETTINGS_FILE` | the voices and models picked in the [settings UI](#settings-ui), default `var/settings/voice.json`. As soon as it names an active voice, it wins over the `SPRECHSTUNDE_TTS_*` and `SPRECHSTUNDE_LLM_*` variables above; a missing or unreadable file leaves them in charge |
| `SPRECHSTUNDE_VOICES_DIR` | where a preset's `refAudio` clip lives, default `var/voices` (mounted read-only into the containers). A preset may only name a relative path inside it; `SPRECHSTUNDE_TTS_REF_AUDIO` stays unrestricted |
| `SPRECHSTUNDE_ADMIN_PORT` | port of the settings UI on `127.0.0.1`, default `8091` |
| `SPRECHSTUNDE_MISTRAL_SERVER` | empty: Mistral's global endpoint, which does not say where a request runs. `eu` or `us`: [regional inference](https://docs.mistral.ai/inference/regional-inference), processing stays in that region, billed at 1.1× list price. A URL is used as is |
| `SPRECHSTUNDE_TRANSCRIPT_DIR` | debug only, off when empty: writes what caller and agent said, plus turn events, to `<dir>/<date>/<job id>.jsonl`. In compose any non-empty value turns it on and writes to `var/transcripts` |
| `SPRECHSTUNDE_ANSWER_TIMEOUT` | seconds Asterisk lets LiveKit ring before it plays the fallback, default `10` |
| `SIP_PROVIDER_*`, `TRANSFER_TARGET_NUMBER`, `TRANSFER_SIP_HOST` | Asterisk's provider registration and the one number a call may be transferred to; it replaces the profile's `transfer.target` — see `.env.example` |

### Profiles

`profiles/example/` holds a **made-up** venue. A real profile (greeting, facts, transfer target)
belongs outside this repository. The greeting must tell the caller they are talking to an AI
(EU AI Act, Art. 50); `loadProfile` refuses an empty one.

The example's transfer target `tel:+4900000000` is invalid on purpose.

`selfDescription` (optional) is what the assistant says when asked what it is, verbatim and for any
locale, e.g. `"ein KI-gestützter digitaler Helfer"`; without it a German persona with a stated gender
uses the built-in "KI-Assistent(in)" wording.

`timeZone` (IANA, e.g. `Europe/Berlin`) is required: the prompt states the venue's local date and
weekday, otherwise "are you open tonight?" is answered from a guessed date.

## Models

Defaults: Mistral `voxtral-mini-transcribe-realtime-2602` (STT), `mistral-small-latest` (LLM),
`voxtral-mini-tts-latest` (TTS), Silero VAD and LiveKit's multilingual turn detector.

Known gap: the Mistral TTS plugin ships no German preset voice (only English, British and French
ones). Options:

1. **Preset voices speaking German.** Voxtral supports German, so a preset may do. Listen first:
   `npm run tts:try` (needs `MISTRAL_API_KEY`) synthesises a German test sentence with several
   voices (`--voice <id>`, `--ref <audio file>`, `--text "…"`, `--model`) and writes
   `var/samples/<YYYY-MM-DD>_tts-try/<voice>.wav` plus a `.8k.wav` that approximates the phone line, with time to first
   audio and total time per voice.
2. **Clone from reference audio.** 2–3 s of speech are enough. `dev/fetch-thorsten-sample.sh`
   downloads one CC0 clip of the Thorsten-Voice dataset to `var/voices/thorsten.wav`. Use it with
   `"voice": {"refAudio": "…"}` in the profile (path relative to the profile file; not together
   with `ttsVoice`) or `SPRECHSTUNDE_TTS_REF_AUDIO=<path>`, which wins. The file is sent
   base64-encoded with every synthesis request, so keep it short: in one measurement (5 runs
   each) a 4 s clip started as fast as a preset voice, an 8 s clip about 150 ms later.
   `dev/record-voice.sh [name] [seconds]` records your own voice. Only clone a voice whose owner
   agreed — Mistral's terms forbid cloning without explicit consent.
   Saved voices (`npm run voice -- create <name> <file> [lang] | list | delete <id>`) avoid the
   upload but need pay-as-you-go enabled in Mistral's admin panel (Free mode answers 403); in
   one measurement they were not faster than a 4 s reference clip. `tts:try --repeat N` reports the median and maximum.
3. **Self-hosted:** Kyutai Pocket TTS, see [Local voice](#local-voice-kyutai-pocket-tts).
   Avoid the popular Piper `thorsten` models for commercial use: they are fine-tuned from the
   research-only Lessac voice
   ([model card](https://huggingface.co/rhasspy/piper-voices/raw/main/de/de_DE/thorsten/high/MODEL_CARD),
   [licence](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html)).

### Local voice: Kyutai Pocket TTS

[Pocket TTS](https://github.com/kyutai-labs/pocket-tts) runs on the CPU, with German among its
official languages and a German preset voice, `juergen`. Code MIT; weights and voices
[CC-BY-4.0](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning): credit Kyutai where
the voice is used. Voice cloning needs separately gated weights with their own terms; the preset
voices do not.

```sh
podman compose --profile pocket up -d pocket-tts   # builds deploy/pocket-tts, downloads the weights
SPRECHSTUNDE_TTS_PROVIDER=pocket SPRECHSTUNDE_TTS_NAME=Jürgen \
SPRECHSTUNDE_TTS_FALLBACK_PROVIDER=mistral SPRECHSTUNDE_TTS_FALLBACK_VOICE=<voice id> npm run agent:dev
```

- `deploy/pocket-tts/server.py` keeps one model per worker process (`POCKET_WORKERS`, default 4,
  `POCKET_THREADS` each, default 2): generation is not thread-safe, so `pocket-tts serve` with its
  single model cannot speak two answers at once. A request waits at most 1 s for a free worker,
  then gets 503 and the fallback voice speaks that chunk.
- **Capacity per call:** with a fallback voice configured, every call first reserves one of
  `POCKET_MAX_SESSIONS` (default twice the workers). A call that gets none speaks with the
  fallback voice and name from start to end, so the caller never hears the voice change because
  the server is busy. Sessions free themselves after an hour if the agent never released them.
- **Numbers as words:** Pocket TTS dropped digits ("19:00 Uhr", "4 Personen") in almost every run
  on 2026-10-19; written out, the sentences came through whole. The agent therefore spells out
  times, dates, prices, percentages, ranges, phone numbers and counts before a German text goes
  to Pocket (`src/core/spoken-numbers.ts`). Transcripts keep the digits.
- **One measurement, 2026-10-19** (i9-10900K, `german` model, `juergen`, 2 threads per process):
  first audio 73–126 ms for one answer at a time, ~3.5x real time. In parallel: 2 → 138 ms /
  2.5x, 4 → 208 ms / 1.4x, 6 → 285 ms / 0.95x (falls behind). A caller mostly listens, so 4
  workers should carry more than 4 calls; that is an estimate, not measured. Measure on the
  target server before relying on it.
- Memory: ~0.75 GB per worker (4 workers ≈ 3 GB); the image is ~1.5 GB with the weights and the
  preset voices. Which voices are baked in is the build argument `POCKET_PRESET_VOICES`
  (default `juergen alba`); the image runs with `HF_HUB_OFFLINE=1`, so a voice that was not baked
  in cannot be loaded later. `POCKET_VOICE` picks the server's default among them and a request's
  `voice` field overrides it per request, so switching between baked voices needs no rebuild.
- Reference audio: a cloned voice from an 8–10 s clip worked; a 19 s clip broke sentences off.

If you use Mistral's API, check the training opt-out in the admin panel (Privacy → "Anonymous
improvement data").

### Running on a server

`compose.server.yaml` and `deploy/systemd/sprechstunde.service` run the same stack in a Proxmox LXC
with rootful Podman; see [docs/deploy/proxmox-lxc.md](docs/deploy/proxmox-lxc.md).

### Latency and robustness

What the agent does beyond the defaults, and why:

- **VAD `minSilenceDuration` 300 ms** instead of Silero's 550 ms. Realtime STT finalises only at
  the VAD's end of speech, so the silence it waits for adds to every reply. The turn detector
  still decides whether a pause ends the turn.
- **Preemptive TTS** on top of LiveKit's default preemptive LLM: the voice starts on the guessed
  turn, which saves the TTS first-byte time (~0.6 s) whenever the guess holds.
- **TTS chunking:** the first chunk is ≥ 20 characters, later ones ≥ 150 (at most 400), instead
  of one request per sentence. A cloned voice is cloned anew for every request and can drift.
- **STT fallback:** the realtime model is wrapped in `StallGuardSTT` (2.5 s without a transcript
  after the end of speech counts as a failure), then `voxtral-mini-latest` as batch STT via
  `stt.FallbackAdapter`. On 2026-10-16 Mistral's realtime STT answered with `TooManyRequests` /
  `QueueOverflow` errors and twice took more than 20 s to deliver a transcript.
- **Stall rescue:** `StallGuardSTT` also saves the stalled utterance. It buffers the audio since
  the last final transcript (at most 15 s) and transcribes it with the batch model (5 s timeout)
  before it fails over. A final transcript that arrives late still gets a reply. The rescue owns
  the utterance from the moment it starts: a transcript the realtime stream delivers afterwards is
  dropped, because it is the same words a second time.
- **LLM fallback** (off by default): with `SPRECHSTUNDE_LLM_FALLBACK_MODEL` set, both models go
  behind `llm.FallbackAdapter` and the second is asked when the first has not answered within
  `SPRECHSTUNDE_LLM_ATTEMPT_TIMEOUT` seconds (default 3) or fails. On 2026-10-19 Mistral answered
  single requests only after 10 s and returned 503s mid-call, which leaves the caller in silence.
  Three seconds is already a long pause on the phone, and the second model needs its own time on
  top. Not seen firing in a real call yet.
- **One contiguous frame for batch STT** (`ContiguousSTT`, `src/agent/stt-merge.ts`):
  `mergeFrames` in `@livekit/agents` 1.9.3 is quadratic. On 2026-10-16 it blocked the event loop
  for 12.3 s on about 12 s of audio (`npm run bench:merge-frames`). The wrapper hands the batch
  model a single frame instead. Remove it once upstream is linear.
- **Hedged TTS** (`HedgedTTS`, `src/agent/tts-hedge.ts`): if a chunk has no audio after 1.5 s, a
  second identical request races the first and the loser is aborted. On 2026-10-16 Mistral TTS
  held single chunks back 6–9 s. A hedged chunk costs twice and appears twice in the metrics.
  It has not been seen firing in a real call yet.
- **No `lookup_fact` tool:** the facts are part of the instructions. A tool call cost a second
  LLM round of 0.4–0.9 s.
- **One measurement, 2026-10-16** (one browser call per setting, about 15 user turns): median
  end-of-utterance delay 1248 → 756 ms, median transcription delay 1153 → 679 ms. Batch STT took
  ~0.7–1.1 s per 3 s clip against ~0.4–0.55 s for realtime finalisation. Single measurements,
  not a benchmark.
- **Latest measurement, 2026-10-16** (several browser calls, small n): median end-of-utterance
  delay 885 ms, transcription 752 ms, LLM time to first token 497 ms, TTS time to first byte
  538 ms. Again a small sample, not a benchmark.
- `npm run stt:try <audio file> [--delay ms]... [--repeat n]` measures the realtime STT's
  finalisation time. `target_streaming_delay_ms` showed no clear effect in one measurement; the
  LiveKit plugin 1.9.3 does not forward it anyway.
- `npm run tts:try -- --split` synthesises sentence by sentence like the former agent, to compare
  voice consistency; `--suffix <name>` names the output file.

## Privacy

The agent logs latency metrics to `var/metrics/<date>.jsonl` (`SPRECHSTUNDE_METRICS_DIR`) —
numbers, ids and timestamps only. A directory it cannot write costs a warning, not the call. It
does not store transcripts or caller numbers unless `SPRECHSTUNDE_TRANSCRIPT_DIR` is set: that
switch is for one's own test calls and logs a warning at every call; production leaves it empty,
and files under `var/transcripts` are deleted by hand once the bug is understood. The dispatch rule sets `hidePhoneNumber`, so
LiveKit names the room and the caller after the last four digits and identifies them by an unsalted
hash of the number: a pseudonym, not anonymity. The `livekit/sip` container still logs the full
number; `npm run provision` replaces a rule created before this setting.

The worker drops every `lk.pii.*` field @livekit/agents puts in its own log lines (caller and assistant text, at every level) before it reaches stdout, in each process, with no switch; `dev`'s pretty output is not covered.

### Latency percentiles

`npm run metrics` reads `var/metrics/*.jsonl` (`SPRECHSTUNDE_METRICS_DIR`) and prints n, p50, p95
and max per metric (end-of-utterance delay, transcription delay, LLM TTFT, TTS TTFB, durations).
Collect many calls first, then look at the tail: p95 over a single call says little.

```sh
npm run metrics                          # everything on disk
npm run metrics -- --day 2026-10-16      # one UTC day (or --since / --until)
npm run metrics -- --calls               # one row per call (gap > 60 s starts a new call) + total
npm run metrics -- --json
```

Percentiles are nearest-rank. A TTS chunk hedged by `HedgedTTS` can appear twice; lines are not
de-duplicated. Malformed lines are skipped and counted.

## Settings UI

Which voice a venue sounds best in is decided by ear, and changing it through `.env` means editing
a file and restarting the worker between every two candidates. The settings UI takes that loop out
of the shell:

```sh
npm run admin                                     # http://127.0.0.1:8091
podman compose --profile agent up -d admin        # same thing in the container
```

The page is a Svelte 5 app in `web/` (Vite, Tailwind CSS 4, bits-ui), a separate npm package with
its own lockfile. `npm run build` compiles it to `dist/web/`, which the admin server serves; without
that build the server answers 503. Pages: overview, characters, LLM,
models (with the vendor voice catalog), knowledge and tools, calls. For development run `npm run web:install` once, then `npm run admin` and
`npm run web:dev` (Vite with hot reload, `/api` proxied to `127.0.0.1:8091`). `web/` is checked by
`svelte-check` through `npm run typecheck`.

It keeps a gallery of **characters** — a name, a gender, a voice with a fallback voice, an optional
manner of speaking and an initials avatar. A venue (profile) picks its character in the knowledge
editor; without a pick it speaks as the default one. A casting wizard creates or edits a character:
who (name, gender, manner), casting (a voice browser over every vendor's voices: filter by vendor,
language, gender, age, category and quality, only EU endpoint or only local, search, tabs for all,
own and favourite voices, a recommended row and paged results; each voice plays the vendor sample or
reads the venue's real greeting with the new name and shows the time to first audio; the gender from
the first step pre-sets the filter, and voices whose vendor states no gender stay reachable as
"unknown"; favourites live in the browser's local storage for now), an A/B comparison of two
picks, and a fallback voice that is pre-selected (another vendor, local first). "Phone quality"
resamples a sample to the 8 kHz a line carries. The manner reaches the system prompt as a short
speaking-style section; the gender only changes how the German prompt names the assistant.
`voice.json` is schema version 2; a file from before (presets) loads and is migrated, with the gender
of each migrated character left open until somebody states it. The same area sets the LLM and lists
the measured latency of recent calls, grouped by character. Design: `docs/adr/0001-multi-tenant-platform.md`.

Models are shown by a readable name with the id beside it. The **Models** page lists what each
vendor offers: Mistral's aliases (`mistral-small-latest`) sit under the model they currently resolve
to, deprecated models are flagged but stay selectable, and the overview warns when one is in use.
Descriptions, context size, tool support and prices appear only where the vendor's API states them;
Cartesia and Pocket publish no model list, so they show their default model from the vendor's docs.

A profile dropdown picks which venue profile (a `*.json` file in `SPRECHSTUNDE_PROFILES_DIR`) the
next calls use; "start profile" means the one the agent was started with. The profile id lands in
the `call_config` metrics line.

The Knowledge page edits a profile in `SPRECHSTUNDE_PROFILES_DIR`: name, greeting (never empty,
the AI disclosure), instructions, facts (add, edit, delete, reorder), the transfer announcement and
target, the fallback text. Tools and the system prompt are read-only; the prompt shows what the
edited draft would produce. A save is checked by the loader's own parser, keeps every field the page
does not edit, is written atomically, and copies the old file to `.history/` first (the newest 20
per profile; `History` restores one). A save from a stale page is refused with 409. The transfer
target never reaches the browser in full: it shows masked, and an empty field keeps it. The start
profile and anything outside the profiles directory are read-only; "Duplicate into profiles
directory" copies one. `compose.yaml` mounts `var/profiles` read-write into `admin` only; the
profiles, `.history/` included, are state and stay out of git.

`GET /api/catalog/<kugel|mistral|cartesia|openrouter|pocket|llm>` lists what a vendor offers right
now — models and voices with languages, gender and, where the vendor has one, a ready-made sample
URL — so new voices can be tried without reading vendor docs. `?language=de` filters, `?refresh=1`
skips the one-hour cache. A vendor without a key, or one that does not answer, comes back as
`available: false` with a reason instead of an error. Only the admin asks; a call never waits on a
catalog. Pocket's list comes from its own `GET /voices`.

What it writes is `var/settings/voice.json` (`SPRECHSTUNDE_SETTINGS_FILE`). The agent reads that
file when a call starts, so the next caller hears the new voice without a restart — and as long as
the file names no active voice, or cannot be read, the `SPRECHSTUNDE_TTS_*` and `SPRECHSTUNDE_LLM_*`
variables stay in charge exactly as before.

It binds to `127.0.0.1` and has **no login**: whoever reaches the port may change the voice and
spend API credit on previews. It refuses a request whose `Host` is not loopback and a change that
does not come from its own page, which stops a browser elsewhere on the machine from driving it, but
it is not an admin panel to expose — do not forward the port, and do not put it on a public
interface. Write requests need a same-origin `Origin` header, so a plain `curl` write is rejected by design.

### Knowledge sources

The **Sources** page gives each venue text the assistant answers from, next to the facts in its
profile: your own Markdown, one web page, or the pages of a `sitemap.xml` (filtered by patterns such as
`/menu/**`; links are not followed). Every fetch is stored as a revision. A page that changed does
**not** go live by itself: the page shows a line diff and you accept or discard it. A source may opt
into accepting changes without asking; a hand edit is a new revision, and a later fetch warns before it
would overwrite one. Every section keeps its history.

Fetching is polite and bounded: only `http(s)` on ports 80/443, a host that resolves to any private or
local address is refused (the connection is pinned to the checked address, redirects are re-checked),
`robots.txt` is obeyed, one request per second and host, 15 s, 5 MB, 30 pages per fetch. Fetched
pages are converted with [cheerio](https://github.com/cheeriojs/cheerio),
[turndown](https://github.com/mixmark-io/turndown) and turndown-plugin-gfm (all MIT).

The sources live in SQLite (`var/db/sprechstunde.sqlite`, `SPRECHSTUNDE_DB`; every table carries a
`tenant_id` and all SQL sits in one repository module). The admin is the only writer. When what is
live changes it writes the venue's text atomically to `<profile>.knowledge.md` next to the profile; the
agent reads that file at the start of a call and never opens the database. In the prompt each section
carries its source, address and date, and the text is fenced as reference data, not instructions.
Sources with an interval (default daily) are refreshed by the admin process while it runs.

**PDF and picture sources** are read by Mistral OCR (`mistral-ocr-latest`) and then follow the same
review as a page: one pending revision, a diff, accept or discard. Upload a PDF (up to 20 MB, one per
source) or pictures (PNG, JPEG, WebP, up to 10 MB each, up to 30, read in the order added) on the
Sources page, or give the address of the file; the address goes through the same safe fetcher as a web
page and is refreshed the same way, but is read again only when its bytes changed, as is an upload
with the same SHA-256. The type comes from the first bytes, not from the name or the content type.
Pages are capped at 30 per document (the review says so when it cut). The originals sit next to the
database under `var/db/files/<tenant>/<sha256>`, never in the profiles directory, and are served only
by the admin API, a PDF as a download and a picture inline, both under a sandbox policy.

**Data protection:** the uploaded document itself is sent to Mistral for OCR, through the endpoint
`SPRECHSTUNDE_MISTRAL_SERVER` selects (`eu` keeps processing in the EU). That is a processing of the
venue's documents by a processor: cover it in the data processing agreement (AVV) before using it with
a customer's files. Whether an AVV with Mistral is on file is not verified here.

The assistant is told never to promise that a dish is free of an allergen: it repeats only what the
facts or the reference data state and otherwise says it does not know and offers a person. That is
a prompt rule, a model can still get it wrong; an OCR misreading of an allergen list is the reason the
review step exists, so read those lines.

The admin has no login yet (ADR step 3): it must stay loopback-only until authentication lands. The
sources API relies on the same `Host` and origin checks as the rest of it and does not relax them.

## Not tested yet

- Fetching is tested against fakes and a loopback server, not against real sites, real `robots.txt`
  files or a sitemap of a live venue.
- OCR was called live once on 2026-10-20 (EU endpoint, `mistral-ocr-latest`) with a generated one-page
  PDF and a PNG, and read both correctly. Real menus, scans, handwriting, multi-page and 30-page
  documents, the page cap against the real API and the cost per page are unverified, as is the
  upload from a browser (drag and drop and the file picker have no automated browser test).
- The characters gallery and the casting wizard are covered by backend tests and a type check, not by
  automated browser tests. Voices of every vendor but Mistral have not been previewed through the
  wizard against the live APIs, and a gender that a vendor reports is taken as given.
- The settings UI has only been exercised by its own tests with a fake vendor: routes, validation,
  the WAV it returns and the two guards. Previews against the real vendors, the latency view on
  grown metrics files and a call that picks up a voice changed mid-shift are unverified, as is the
  `admin` container.
- KugelAudio (`kugel`) has been heard once, outside a call: one German sentence through the
  provider build path over the EU endpoint, `kugel-3.5`, first audio after about a fifth of a
  second. Never used in a call, never with the fallback voice, and the text normalization that
  replaces our own number spell-out is unchecked beyond that sentence. Its licence terms and
  whether a data processing agreement (AVV) is on file are **not verified**.
- Pocket TTS on a phone call, the session limit and the switch to the fallback voice under load:
  covered by unit tests with a fake server and by hand against the real server, not in a call.
  A mid-call failure switches to the fallback voice while the assistant keeps the first voice's
  name.
- Only one provider so far: 1&1 works with TLS registration, SDES-SRTP (`AES_CM_128_HMAC_SHA1_80`)
  and inbound calls, over IPv6 from behind a FRITZ!Box (`SIP_PROVIDER_IPV6=yes`). Over IPv4 the
  router rewrote the RTP source port even for forwarded ports and 1&1 sent no audio; IPv4 behind
  NAT (`SIP_PUBLIC_ADDRESS`) is therefore unproven, and a host with a public address is untested.
- 1&1 keeps a registration about two hours, not the requested ten minutes, and allows only a few
  contacts per number. Unregistering on stop is verified with `sip:contacts`; a killed container
  still leaves its contact behind.
- The agent container under memory pressure (2026-10-18): its inference and job processes ended,
  the worker stayed registered, and every call got the fallback for a day. `start` now polls its
  own health endpoint (`:8081/`, 503 once the inference process is gone) and exits after four
  failed probes 15 s apart, so `restart: unless-stopped` brings it back. Covered by unit tests
  with a fake probe; the real failure has not been reproduced.
- Interruptions need 0.8 s of speech and two recognised words since a phone test where the agent
  broke off and restarted answers four times in one call. Whether that was backchannel, echo or a
  turn ended too early is not known; untested after the change.
- On a transfer over 1&1 the target sees the assistant's own number, not the caller's. Whether
  Asterisk sends it or 1&1 replaces whatever Asterisk sends is not checked; passing the caller's
  number through would need the provider to allow it.
- Transfer over 1&1 reached a person on a mobile on 2026-10-19 and both sides heard each other;
  the REFER goes to `sip:<TRANSFER_TARGET_NUMBER>@TRANSFER_SIP_HOST`, because Asterisk answers a
  `tel:` target with 400. What the caller hears while it rings is not written down yet.
- The optional `agent` container (`podman compose --profile agent up`): the image builds and, in
  assistant mode, starts and registers as a worker with LiveKit (turn-detector files found, metrics
  directory writable, German catalogue present). A dispatch probe without a phone ran a session
  in it, greeting synthesised and clean close. Phone calls through it, including a transfer, worked
  on 2026-10-19.
- The stall guard and the batch fallback are covered by unit tests with fake STTs, not yet by a
  real Mistral outage. The rescue path and `HedgedTTS` are verified only with fakes.
- The session now shuts the job down when the caller hangs up; untested in a real call.
- Echo mode closes its audio stream, track and source on shutdown; checked against the rtc-node
  API, not against a running call.
- The fallback with no agent running: an Asterisk-internal call into `[from-provider]` rang
  LiveKit and played `fallback.wav` after 10 s, and on 2026-10-19 a real caller over 1&1 heard it
  while the agent hung (see the memory-pressure item). Without a
  recording the "no service" prompt is English: Debian packages no German Asterisk core sounds.

## Development

```sh
npm run typecheck && npm test && npm run build
npm run i18n:extract && npm run i18n:compile   # English msgids, German in po/de.po
```

Architecture decisions live in [docs/adr/](docs/adr/), starting with
[the multi-tenant platform](docs/adr/0001-multi-tenant-platform.md).

## License

Apache-2.0
