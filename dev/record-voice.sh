#!/usr/bin/env bash
# Record a short reference clip of your own voice for Voxtral's zero-shot cloning.
#
#   dev/record-voice.sh [name] [seconds]    default: name=own, seconds=12
#
# Writes var/voices/<name>.wav (mono, 24 kHz, 16 bit). var/ is gitignored: a voice is personal
# data and never belongs in the repository. Only clone a voice whose owner agreed to it.
set -euo pipefail
# German locales print "8,0"; printf then rejects ffprobe's "8.04".
export LC_NUMERIC=C

cd "$(dirname "$0")/.."
NAME="${1:-own}"
SECONDS_TO_RECORD="${2:-12}"
# A non-number silently becomes a zero-second countdown and a 1.5 s clip of the warm-up.
if ! [[ $SECONDS_TO_RECORD =~ ^[0-9]+$ ]] || [ "$SECONDS_TO_RECORD" -lt 3 ]; then
    echo "seconds must be a whole number of at least 3, got '$SECONDS_TO_RECORD'" >&2
    exit 1
fi
# pw-record needs a moment before audio actually arrives; speaking during that window is what
# cut off the start of the first take. We record it and drop it afterwards.
WARMUP=1.5
OUT="var/voices/$NAME.wav"
RAW="$(mktemp --suffix=.wav)"
REC_PID=''
trap '[ -n "$REC_PID" ] && kill "$REC_PID" 2>/dev/null; rm -f "$RAW"' EXIT
mkdir -p var/voices

command -v ffmpeg >/dev/null || { echo 'ffmpeg is required' >&2; exit 1; }

cat <<'EOF'
Read this aloud in a calm, friendly phone voice (the clone copies tone and pace):

  "Guten Tag, schön, dass Sie anrufen. Wir haben heute von zwölf bis
   zweiundzwanzig Uhr geöffnet, und Hunde sind auf der Terrasse herzlich willkommen."

Wait for ">>> SPEAK NOW <<<" before you start.
EOF
read -r -p 'Press Enter when ready… ' _

total="$(awk -v a="$SECONDS_TO_RECORD" -v b="$WARMUP" 'BEGIN { print a + b + 1 }')"
if command -v pw-record >/dev/null; then
    timeout "$total" pw-record --channels=1 --rate=48000 "$RAW" &
else
    arecord -q -f S16_LE -c 1 -r 48000 -d "${total%.*}" "$RAW" &
fi
REC_PID=$!

printf 'preparing microphone…\n'
sleep "$WARMUP"
printf '\a\n\033[1;32m  >>> SPEAK NOW <<<\033[0m\n\n'
for ((left = SECONDS_TO_RECORD; left > 0; left--)); do
    printf '\r  %2ds left ' "$left"
    sleep 1
done
printf '\r  done.        \n'
wait "$REC_PID" || true
REC_PID=''

# Drop the warm-up, then trim silence but keep 0.3 s on both ends: cutting right at the
# threshold clips soft onsets like the "G" of "Guten Tag".
ffmpeg -loglevel error -y -ss "$WARMUP" -i "$RAW" \
    -af 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.3,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.3,areverse,loudnorm' \
    -ac 1 -ar 24000 -sample_fmt s16 "$OUT"

duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")"
if ! awk -v d="$duration" 'BEGIN { exit !(d + 0 >= 3) }'; then
    rm -f "$OUT"
    echo 'less than 3 s of speech recorded — check the microphone (pavucontrol) and try again' >&2
    exit 1
fi
printf 'wrote %s (%.1f s)\n' "$OUT" "$duration"
printf 'listen: pw-play %s\n' "$OUT"
printf 'try it: npm run tts:try -- --ref %s\n' "$OUT"
