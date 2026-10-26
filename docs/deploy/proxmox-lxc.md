# Running sprechstunde in a Proxmox LXC

The same `compose.yaml` as on a workstation, plus `compose.server.yaml`, in an unprivileged Debian 13
LXC with rootful Podman. Every value below is a placeholder (`<…>`): the real ones live in the
server's `.env` and in the router's configuration, never in this repo.

## What the stack opens to the network

Every service runs with host networking and binds to `127.0.0.1`: Valkey, LiveKit (7880, UDP
50000-50100; its ICE/TCP port is switched off with `tcp_port: 0`), LiveKit SIP (5060, UDP 10000-10100), the agent's health endpoint (8081) and the admin
(8091). The one thing that must be reachable from outside is **Asterisk's RTP range**, UDP
`SIP_RTP_START`-`SIP_RTP_END` (default 12000-12100). Nothing else gets a forward or a DNS entry. The
admin has no sign-in yet (ADR step 3), so it is reached through an SSH tunnel only.

## LXC

| Setting | Value |
|---|---|
| Template | Debian 13, unprivileged |
| Features | `nesting=1,keyctl=1` |
| Size | 4 cores, 6 GB RAM, 1 GB swap, 32 GB disk |
| Autostart | `onboot=1`, ordered after the router |
| Device | `/dev/net/tun`: `pct set <id> --dev0 /dev/net/tun` (image builds run their `RUN` steps behind pasta) |
| DNS | `pct set <id> --nameserver <router-address>` before anything else: the LXC inherits the host's resolvers, which the guest network cannot reach |

Inside the LXC:

```sh
apt update && apt full-upgrade -y
apt install -y podman git ca-certificates
# `podman compose` needs a compose provider. Not podman-compose 1.3.0 (Debian's default): it does
# not expand `${VAR:-default}`, so containers get the literal text. Use docker-compose on Podman's socket.
apt install -y docker-compose
systemctl enable --now podman.socket
mkdir -p /etc/containers/containers.conf.d
printf '[engine]\ncompose_providers = ["/usr/bin/docker-compose"]\n' > /etc/containers/containers.conf.d/compose.conf
git clone https://github.com/JumpLink/sprechstunde /opt/sprechstunde
cd /opt/sprechstunde
```

Smoke-test Podman before anything else: `podman run --rm docker.io/library/debian:trixie-slim true`,
then the stack with `up -d --force-recreate` a few times. Repeated `crun` errors (`uid_map`, `devpts`,
mount) mean an unprivileged LXC is the wrong home; use a VM with the same settings instead.

## `.env`

Copy `.env.example` to `/opt/sprechstunde/.env` (mode 600) and fill it in by hand; transfer it
yourself, do not paste it into a ticket or chat. Keys the server needs:

- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`: any random pair.
- `MISTRAL_API_KEY`, `SPRECHSTUNDE_MISTRAL_SERVER`; `KUGELAUDIO_API_KEY` / `CARTESIA_API_KEY` /
  `OPENROUTER_API_KEY` only for the vendors in use.
- `SPRECHSTUNDE_MODE=assistant`, `SPRECHSTUNDE_PROFILE`, the `SPRECHSTUNDE_TTS_*` and
  `SPRECHSTUNDE_LLM_*` values.
- `SIP_PROVIDER_HOST`, `_DOMAIN`, `_USER`, `_PASSWORD`, `_NUMBER`, `SIP_PROVIDER_MEDIA_ENCRYPTION`,
  `TRANSFER_TARGET_NUMBER`.
- Behind NAT: `SIP_PUBLIC_ADDRESS` (the router's public IPv4), optionally
  `SIP_PUBLIC_SIGNALING_ADDRESS`, `SIP_LOCAL_NET` (the networks that need no rewriting; the default is
  all private ranges) and `SIP_RTP_START` / `SIP_RTP_END`. The router's forward must cover exactly
  that range.
- Leave `SPRECHSTUNDE_TRANSCRIPT_DIR` unset: `compose.server.yaml` forces it empty anyway.

## Build, start, verify

`.env` must exist first, with at least `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`: compose refuses to
read the files without them, build included. The first build takes about 5 minutes on the E3-1275 v5.
`compose.server.yaml` runs `agent` and `admin` with `userns_mode: host` (`keep-id` fails in the LXC),
so `var/` must belong to uid/gid 1000.

Build `agent` only: `admin` runs the same image. Building it under both names ran two `vite build`s in
parallel, which with the running stack exhausted the LXC's 6 GiB limit and made it thrash. The
`asterisk` and `pocket-tts` images build on the first `up` when missing; build them one at a time too.

```sh
cd /opt/sprechstunde
mkdir -p var/settings var/metrics var/transcripts var/voices var/profiles var/db var/valkey
chown -R 1000:1000 var
podman compose -f compose.yaml -f compose.server.yaml --profile agent build agent
install -m 644 deploy/systemd/sprechstunde.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now sprechstunde
```

Provision LiveKit once the stack is up: it creates the SIP inbound trunk and the dispatch rule, which
Valkey keeps in `var/valkey` across restarts (AOF), so this is an install step, not a boot step:

```sh
podman exec sprechstunde-agent-1 node dist/cli/provision.js
```

Until `.env` holds the trunk values the `asterisk` container exits with "SIP_PROVIDER_HOST must be
set": expected, the rest of the stack runs.

The unit needs `podman.socket` (it `Requires=` it) and runs `up -d` at boot and `down` at shutdown; the compose files carry
`restart: unless-stopped`. Check:

```sh
podman ps --format '{{.Names}} {{.Status}}'        # all up, agent "healthy"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/   # 200
ss -ltnu | grep -E ':(8081|8091|7880|5060|5070) '  # every one on 127.0.0.1
podman exec <asterisk container> asterisk -rx 'pjsip show registrations'   # Registered
```

## Admin through an SSH tunnel

The admin listens on `127.0.0.1:8091` inside the LXC. A Proxmox host whose containers sit on a
bridge without a host address (behind a router VM) cannot reach the LXC's sshd, so `ssh -J` hangs.
Tunnel through `pct exec` instead; it needs `nc` in the LXC (`apt install netcat-openbsd`):

```sh
ssh -o HostKeyAlias=<lxc-name> \
  -o ProxyCommand="ssh <user>@<proxmox-host> pct exec <id> -- nc 127.0.0.1 22" \
  -L 8092:127.0.0.1:8091 root@<lxc-name>
```

then open `http://127.0.0.1:8092` (8091 stays free for a local admin). The alias pins the LXC's
host key under its own name. Do not forward 8091 on the router or publish it under a domain
before ADR step 3.

## NAT forward

On the router in front of the LXC, one rule:

| Protocol | From | Destination port range | To |
|---|---|---|---|
| UDP | any (see below) | `<SIP_RTP_START>`-`<SIP_RTP_END>` | `<lxc-address>`, same range |

No rule for the admin. Whether the provider sends media from fixed networks is **not verified**;
restricting the source needs a primary source from the provider, so leave it open until then.

A SIP port forward should not be needed: Asterisk registers outbound over TLS and the provider's
inbound INVITEs arrive over that registration (`line=yes`). That is **unverified** for a server
behind NAT; the first inbound test call settles it.

## Moving the trunk

The provider allows few contacts per number, and a second registration from another place takes calls
away from the first. Register in **one place at a time**.

To the server:

1. On the workstation: `podman compose stop asterisk` (it unregisters on stop). Check with
   `npm run sip:contacts` that no contact is left.
2. On the server: start the stack with the trunk values in `.env`, wait for `Registered`.
3. Place a test call: audio both ways, transfer, caller number.

Back: stop `asterisk` on the server first, confirm the registration is gone, then start it on the
workstation. A killed container leaves its contact behind for about two hours.

## Updating and rolling back

Upgrading from a release before Valkey persisted its state: `mkdir -p var/valkey && chown 1000:1000
var/valkey` (the unit's `mkdir` creates it as root otherwise), restart, then run the provision
command above once. The trunk and rule did not survive earlier restarts, so there is nothing to carry
over.

```sh
cd /opt/sprechstunde
git fetch && git log --oneline HEAD..origin/main     # what is coming
git rev-parse HEAD > ~/sprechstunde.previous         # the way back
git pull --ff-only
podman compose -f compose.yaml -f compose.server.yaml --profile agent build agent
systemctl restart sprechstunde
```

Roll back with `git checkout $(cat ~/sprechstunde.previous)`, rebuild, restart. A schema migration of
`var/db` is not undone by that: restore the backup (below) first if a release migrated it.

## Backup and restore

State that exists nowhere else: `var/db` (knowledge database and `var/db/files`, the uploaded
originals), `var/settings/voice.json`, `var/profiles`, and `.env`. They are declared in
`.werkstatt-state.json`. `var/metrics` is numbers only and can be lost.

- Include the LXC in the Proxmox Backup Server job. A snapshot taken while the admin writes can
  catch the SQLite file mid-write: for a consistent copy stop the admin first
  (`podman compose stop admin`) or run `sqlite3 var/db/<file>.sqlite ".backup <target>"`.
- Restore the LXC from PBS, or copy `var/` back into a fresh checkout, `systemctl start sprechstunde`.
- The `.env` is in the LXC backup too, so protect the backup like the secret it contains.

## Known limits

- No sign-in: the admin stays on loopback behind the tunnel until ADR step 3.
- Pocket TTS on this CPU class is unmeasured; the E3-1275 v5 is older than the i9 the README's figures
  come from. Measure it through the admin preview before using it for calls.
- Inbound calls without a SIP forward, source networks of the provider's media, and a
  server-side fetch of real web sources are unverified.
- Transcripts are off by design; debugging a call means reading the container logs and the metrics.
