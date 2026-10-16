#!/usr/bin/env bash
# Talk to a locally running agent from the browser, without a phone line.
# Needs `podman compose up -d redis livekit`, a running `npm run agent:dev` and the `lk` CLI.
# Every run uses a new room: LiveKit dispatches the agent only when a room is created, so
# rejoining a room whose call just ended finds no agent.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./.env
set +a
room="probe-$(date +%H%M%S)"
token="$(lk token create --room "$room" --identity caller --join --agent "${SPRECHSTUNDE_AGENT_NAME:-sprechstunde}" --valid-for 1h 2>/dev/null | grep -oE 'eyJ[A-Za-z0-9._-]+')"
url="https://meet.livekit.io/custom?liveKitUrl=${LIVEKIT_URL:-ws://127.0.0.1:7880}&token=${token}"
echo "room: $room"
xdg-open "$url" >/dev/null 2>&1 || echo "$url"
