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
# extensions.conf reads these via ${ENV(...)}
chown asterisk:asterisk /etc/asterisk/pjsip.conf
chmod 600 /etc/asterisk/pjsip.conf
exec "$@"
