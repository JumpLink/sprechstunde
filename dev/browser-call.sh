#!/usr/bin/env bash
# Talk to a locally running agent from the browser, without a phone line.
# Needs `podman compose up -d redis livekit`, a running `npm run agent:dev` and the `lk` CLI.
# Every run uses a new room: LiveKit dispatches the agent only when a room is created, so
# rejoining a room whose call just ended finds no agent.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
    echo '.env is missing — copy .env.example and fill in the LiveKit keys' >&2
    exit 1
fi
# Read, do not export: `xdg-open` passes its whole environment to the browser, and the Mistral
# and SIP credentials in .env have no business there. Only `lk` gets the LiveKit keys.
# shellcheck disable=SC1091
. ./.env
: "${LIVEKIT_API_KEY:?set it in .env}" "${LIVEKIT_API_SECRET:?set it in .env}"
room="probe-$(date +%H%M%S)"
token="$(LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}" LIVEKIT_API_KEY="$LIVEKIT_API_KEY" \
    LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
    lk token create --room "$room" --identity caller --join \
        --agent "${SPRECHSTUNDE_AGENT_NAME:-sprechstunde}" --valid-for 1h 2>/dev/null |
    grep -oE 'eyJ[A-Za-z0-9._-]+')"
url="https://meet.livekit.io/custom?liveKitUrl=${LIVEKIT_URL:-ws://127.0.0.1:7880}&token=${token}"
echo "room: $room"
xdg-open "$url" >/dev/null 2>&1 || echo "$url"
