#!/usr/bin/env bash
# Fetch ONE short neutral clip of the Thorsten-Voice dataset (CC0) as a reference voice for
# Mistral's voice cloning. Result: var/voices/thorsten.wav (mono WAV; var/ is gitignored).
#
#   dev/fetch-thorsten-sample.sh [offset]   default: first neutral clip of 3-6 s from a good microphone
#
# Needs curl and node; ffmpeg (when installed) downmixes to mono 24 kHz, which keeps the
# per-call upload small: the plugin sends the reference with every synthesis request.
set -euo pipefail

cd "$(dirname "$0")/.."
DATASET='Thorsten-Voice/TV-44kHz-Full'
CONFIG='TV-2021.02-Neutral'
OUT='var/voices/thorsten.wav'
API="https://datasets-server.huggingface.co/rows?dataset=$DATASET&config=$CONFIG&split=train"

mkdir -p "$(dirname "$OUT")"
rows="$(mktemp)"
raw="$(mktemp --suffix=.wav)"
trap 'rm -f "$rows" "$raw"' EXIT

curl -fsS "$API&offset=0&length=30" -o "$rows"

# Prints "<offset> <duration> <audio url>" for the chosen row.
pick="$(ROWS="$rows" WANT="${1:-}" node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.env.ROWS, "utf8"));
const want = process.env.WANT;
const row = data.rows.find((r) =>
  want !== "" ? String(r.row_idx) === want
    : r.row.durationSeconds >= 3 && r.row.durationSeconds <= 6 && String(r.row.microphone).startsWith("good"));
if (!row) { console.error("no suitable row in the first 30"); process.exit(1); }
console.log(row.row_idx, row.row.durationSeconds, row.row.audio[0].src);
')"
read -r offset duration url <<< "$pick"

curl -fsS "$url" -o "$raw"
if command -v ffmpeg > /dev/null; then
    ffmpeg -v error -y -i "$raw" -ac 1 -ar 24000 "$OUT"
else
    echo 'ffmpeg not found: keeping the source channel layout (the dataset is mono already)' >&2
    cp "$raw" "$OUT"
fi

echo "wrote $OUT (row $offset, ${duration} s)"
echo "source:  https://huggingface.co/datasets/$DATASET (config $CONFIG, split train, row $offset)"
echo 'license: CC0 1.0, https://huggingface.co/datasets/Thorsten-Voice/TV-44kHz-Full'
