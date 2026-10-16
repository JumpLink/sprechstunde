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

Asterisk is there because `livekit/sip` cannot register with a provider itself. If the agent is
unreachable, Asterisk answers with a "no service" prompt instead of ringing out.

## Quick start (local)

Needs Node ≥ 22, Podman with `podman compose`, and gettext for the catalogues.

```sh
npm ci
cp .env.example .env          # fill in the LiveKit secret first; the rest can wait
npm run stack:up              # valkey, livekit-server, livekit/sip, asterisk
npm run provision             # inbound trunk + dispatch rule, idempotent
SPRECHSTUNDE_MODE=echo npm run agent:dev
```

`SPRECHSTUNDE_MODE=echo` needs no AI key: the agent plays back what it hears, which tests the
audio path end to end. `assistant` (the default) needs `MISTRAL_API_KEY`.

Before the first `assistant` run, and again after every `npm ci`, download the turn-detector model:
`npm run download-files`. Part of it (the tokenizer) lands inside `node_modules`, so a clean
install deletes it and the agent then fails at start with "Required model files not found locally".

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
| `SPRECHSTUNDE_TTS_VOICE` | override the profile's TTS voice |
| `SPRECHSTUNDE_TTS_REF_AUDIO` | path to an audio file to clone; overrides every other voice setting |
| `SPRECHSTUNDE_TRUNK_NUMBERS` | comma-separated numbers for the inbound trunk; empty accepts any |
| `SPRECHSTUNDE_METRICS_DIR` | where latency metrics are written, default `var/metrics` |
| `SIP_PROVIDER_*`, `TRANSFER_TARGET_NUMBER` | Asterisk's provider registration, see `.env.example` |

### Profiles

`profiles/example/` holds a **made-up** venue. A real profile (greeting, facts, transfer target)
belongs outside this repository. The greeting must tell the caller they are talking to an AI
(EU AI Act, Art. 50); `loadProfile` refuses an empty one.

The example's transfer target `tel:+4900000000` is invalid on purpose.

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
   `var/tts/<voice>.wav` plus a `.8k.wav` that approximates the phone line, with time to first
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
3. **Later: self-hosted** Thorsten-Voice/Kokoro (Apache-2.0, CPU, probably 1–2 concurrent calls).
   Avoid the popular Piper `thorsten` models for commercial use: they are fine-tuned from the
   research-only Lessac voice
   ([model card](https://huggingface.co/rhasspy/piper-voices/raw/main/de/de_DE/thorsten/high/MODEL_CARD),
   [licence](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html)).

If you use Mistral's API, check the training opt-out in the admin panel (Privacy → "Anonymous
improvement data").

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
does not store transcripts or caller numbers.

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

## Not tested yet

- Registration, TLS and SRTP with a real provider (`SIP_PROVIDER_MEDIA_ENCRYPTION=sdes` is a
  guess).
- Transfer: whether LiveKit's REFER reaches Asterisk and Asterisk follows it into `from-livekit`.
  The `from-livekit` pattern now accepts a leading `+` and compares numbers without it; untested.
- The optional `agent` container (`podman compose --profile agent up`): the image builds and, in
  assistant mode, starts and registers as a worker with LiveKit (turn-detector files found, metrics
  directory writable, German catalogue present). No call has gone through it.
- The stall guard and the batch fallback are covered by unit tests with fake STTs, not yet by a
  real Mistral outage. The rescue path and `HedgedTTS` are verified only with fakes.
- The session now shuts the job down when the caller hangs up; untested in a real call.
- Echo mode closes its audio stream, track and source on shutdown; checked against the rtc-node
  API, not against a running call.
- The "no service" prompt is English: Debian packages no German Asterisk core sounds.

## Development

```sh
npm run typecheck && npm test && npm run build
npm run i18n:extract && npm run i18n:compile   # English msgids, German in po/de.po
```

## License

Apache-2.0
