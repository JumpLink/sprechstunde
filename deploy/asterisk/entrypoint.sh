#!/bin/sh
# Render pjsip.conf from the environment so no credentials live in files.
set -eu
export TRANSFER_TARGET_NUMBER="${TRANSFER_TARGET_NUMBER:-}"
# How long LiveKit may ring before the fallback plays. livekit/sip rings until an agent subscribes
# to the call's audio, about 2 s when one is running; with none it would ring on and on.
export SPRECHSTUNDE_ANSWER_TIMEOUT="${SPRECHSTUNDE_ANSWER_TIMEOUT:-10}"
case "$SPRECHSTUNDE_ANSWER_TIMEOUT" in
  ''|*[!0-9]*) echo "SPRECHSTUNDE_ANSWER_TIMEOUT must be whole seconds" >&2; exit 1 ;;
esac

# Lines: one provider registration each. Without SIP_LINES there is one, "main", from SIP_PROVIDER_*
# (the shape from before lines existed); with it, SIP_LINE_<ID>_<FIELD> overrides SIP_PROVIDER_<FIELD>
# per line (ID = the line id uppercased, "-" as "_"). Credentials stay in the environment.
SIP_LINES="${SIP_LINES:-main}"
export LINE_RTP_IPV6=""
[ "${SIP_PROVIDER_IPV6:-no}" != "yes" ] || LINE_RTP_IPV6="rtp_ipv6=yes"
# Sets $value to SIP_LINE_<ID>_<field>, else to $SIP_PROVIDER_<field>.
line_var() {
  key="SIP_LINE_$(echo "$1" | tr 'a-z-' 'A-Z_')_$2"
  eval "value=\"\${$key:-}\""
  if [ -z "$value" ]; then eval "value=\"\${SIP_PROVIDER_$2:-}\""; fi
}
cp /etc/asterisk/pjsip.conf.template /etc/asterisk/pjsip.conf
FIRST_LINE=""
FIRST_HOST=""
seen=" "
for LINE in $(echo "$SIP_LINES" | tr ',' ' '); do
  case "$LINE" in
    ''|*[!a-z0-9-]*) echo "SIP_LINES: \"$LINE\" is not a line id (a-z, 0-9 and - only)" >&2; exit 1 ;;
  esac
  [ "${#LINE}" -le 20 ] || { echo "SIP_LINES: \"$LINE\" is longer than 20 characters" >&2; exit 1; }
  case "$seen" in *" $LINE "*) echo "SIP_LINES: \"$LINE\" is listed twice" >&2; exit 1 ;; esac
  seen="$seen$LINE "
  for field in USER PASSWORD NUMBER HOST DOMAIN; do
    line_var "$LINE" "$field"
    [ -n "$value" ] || { echo "$key (or SIP_PROVIDER_$field) must be set" >&2; exit 1; }
    export "LINE_$field=$value"
  done
  line_var "$LINE" MEDIA_ENCRYPTION
  export LINE_MEDIA_ENCRYPTION="${value:-sdes}"
  export LINE_ID="$LINE"
  if [ -z "$FIRST_LINE" ]; then FIRST_LINE="$LINE"; FIRST_HOST="$LINE_HOST"; fi
  envsubst '${LINE_ID} ${LINE_USER} ${LINE_PASSWORD} ${LINE_DOMAIN} ${LINE_HOST} ${LINE_NUMBER} ${LINE_MEDIA_ENCRYPTION} ${LINE_RTP_IPV6}' \
    < /etc/asterisk/pjsip-line.conf.template >> /etc/asterisk/pjsip.conf
  echo >> /etc/asterisk/pjsip.conf
done
export SPRECHSTUNDE_FIRST_LINE="$FIRST_LINE"
# Several lines register at the same provider host, so a match on the host cannot tell them apart.
# An INVITE with the line parameter of one registration's Contact (`line=yes`) reaches that line's
# endpoint; one without it falls to this identify and is taken for the first line, which is also
# what a single-line installation always did.
cat >> /etc/asterisk/pjsip.conf <<EOF
[provider-$FIRST_LINE]
type=identify
endpoint=provider-$FIRST_LINE
match=$FIRST_HOST
EOF
# RTP range: one variable pair, also what the NAT forward on the router must cover.
RTP_START="${SIP_RTP_START:-12000}"
RTP_END="${SIP_RTP_END:-12100}"
for v in "$RTP_START" "$RTP_END"; do
  case "$v" in ''|*[!0-9]*) echo "SIP_RTP_START and SIP_RTP_END must be port numbers" >&2; exit 1 ;; esac
done
[ "$RTP_START" -lt "$RTP_END" ] && [ "$RTP_END" -le 65535 ] || { echo "SIP_RTP_START must be below SIP_RTP_END (at most 65535)" >&2; exit 1; }
sed -i "s/^rtpstart=.*/rtpstart=${RTP_START}/;s/^rtpend=.*/rtpend=${RTP_END}/" /etc/asterisk/rtp.conf
# IPv6 avoids NAT entirely: a FRITZ!Box rewrites the RTP source port even for forwarded ports,
# and 1&1's media relay then neither accepts our audio nor sends its own.
if [ "${SIP_PROVIDER_IPV6:-no}" = "yes" ]; then
  sed -i '/^\[transport-tls-provider\]/,/^$/s/^bind=0\.0\.0\.0:0$/bind=[::]:0/' /etc/asterisk/pjsip.conf
# Behind NAT (e.g. a home router) the SDP must carry the public address: the provider sends its
# audio there and drops ours when it comes from an address the SDP did not announce.
elif [ -n "${SIP_PUBLIC_ADDRESS:-}" ]; then
  # SIP_LOCAL_NET: comma-separated CIDRs that need no rewriting; default is every private range.
  nets=""
  for net in $(echo "${SIP_LOCAL_NET:-127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}" | tr ',' ' '); do
    nets="${nets}\nlocal_net=${net}"
  done
  sed -i "/^\[transport-tls-provider\]/a external_media_address=${SIP_PUBLIC_ADDRESS}${nets}" /etc/asterisk/pjsip.conf
  # Optional: the address the provider should send SIP to, when it differs from the media one.
  if [ -n "${SIP_PUBLIC_SIGNALING_ADDRESS:-}" ]; then
    sed -i "/^\[transport-tls-provider\]/a external_signaling_address=${SIP_PUBLIC_SIGNALING_ADDRESS}" /etc/asterisk/pjsip.conf
  fi
fi
# extensions.conf reads these via ${ENV(...)}
chown asterisk:asterisk /etc/asterisk/pjsip.conf
chmod 600 /etc/asterisk/pjsip.conf
# Asterisk does not unregister when it is killed, and 1&1 keeps a contact for about two hours
# with only a few allowed per number: a few restarts end in "403 too many contacts".
stop() {
  asterisk -rx "pjsip send unregister *all" >/dev/null 2>&1 || true
  sleep 2
  asterisk -rx "core stop now" >/dev/null 2>&1 || kill "$pid" 2>/dev/null || true
}
trap stop TERM INT
"$@" &
pid=$!
# The first wait returns when the trap fires; the second waits for Asterisk to exit.
wait "$pid" || true
wait "$pid" 2>/dev/null || true
