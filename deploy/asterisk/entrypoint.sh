#!/bin/sh
# Render pjsip.conf from the environment so no credentials live in files.
set -eu
for v in SIP_PROVIDER_HOST SIP_PROVIDER_DOMAIN SIP_PROVIDER_USER SIP_PROVIDER_PASSWORD SIP_PROVIDER_NUMBER; do
  eval "[ -n \"\${$v:-}\" ]" || { echo "$v must be set" >&2; exit 1; }
done
export SIP_PROVIDER_MEDIA_ENCRYPTION="${SIP_PROVIDER_MEDIA_ENCRYPTION:-sdes}"
export TRANSFER_TARGET_NUMBER="${TRANSFER_TARGET_NUMBER:-}"
envsubst '${SIP_PROVIDER_HOST} ${SIP_PROVIDER_DOMAIN} ${SIP_PROVIDER_USER} ${SIP_PROVIDER_PASSWORD} ${SIP_PROVIDER_NUMBER} ${SIP_PROVIDER_MEDIA_ENCRYPTION}' \
  < /etc/asterisk/pjsip.conf.template > /etc/asterisk/pjsip.conf
# IPv6 avoids NAT entirely: a FRITZ!Box rewrites the RTP source port even for forwarded ports,
# and 1&1's media relay then neither accepts our audio nor sends its own.
if [ "${SIP_PROVIDER_IPV6:-no}" = "yes" ]; then
  sed -i '/^\[transport-tls-provider\]/,/^$/s/^bind=0\.0\.0\.0:0$/bind=[::]:0/' /etc/asterisk/pjsip.conf
  sed -i '/^\[provider\]$/a rtp_ipv6=yes' /etc/asterisk/pjsip.conf
# Behind NAT (e.g. a home router) the SDP must carry the public address: the provider sends its
# audio there and drops ours when it comes from an address the SDP did not announce.
elif [ -n "${SIP_PUBLIC_ADDRESS:-}" ]; then
  sed -i "/^\[transport-tls-provider\]/a external_media_address=${SIP_PUBLIC_ADDRESS}\nlocal_net=127.0.0.0/8\nlocal_net=10.0.0.0/8\nlocal_net=172.16.0.0/12\nlocal_net=192.168.0.0/16" \
    /etc/asterisk/pjsip.conf
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
