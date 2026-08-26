#!/usr/bin/env bash
#
# ccledger on an AWS Lightsail instance, or any other plain Ubuntu box.
#
# Paste this into Lightsail's "Launch script" box when creating the instance,
# or run it on a fresh one with sudo. It installs Node, ccledger from npm, and
# Caddy in front for TLS, then runs ccledger under systemd as its own user.
#
# It deliberately does not use Docker. The $5 nano has 512 MB of RAM, and
# building the image there means compiling a native SQLite addon and running a
# Vite build; both run out of memory. Installing the published package is a
# download, so it fits comfortably.
#
# Usage:
#   sudo CCLEDGER_DOMAIN=ccledger.example.com \
#        CCLEDGER_ACME_EMAIL=you@example.com \
#        CCLEDGER_TIMEZONE=Asia/Dhaka \
#        ./lightsail.sh
#
# The domain's A record must already point at this machine: Caddy proves
# control of the name over port 80 and cannot do that before DNS resolves here.
# Leave CCLEDGER_DOMAIN unset to skip Caddy and serve plain HTTP on 4318, which
# is only sensible while you are testing.

set -euo pipefail

DOMAIN="${CCLEDGER_DOMAIN:-}"
ACME_EMAIL="${CCLEDGER_ACME_EMAIL:-}"
TIMEZONE="${CCLEDGER_TIMEZONE:-UTC}"
NODE_MAJOR="${CCLEDGER_NODE_MAJOR:-22}"
PACKAGE="${CCLEDGER_PACKAGE:-@thisissbk/ccledger}"

# Its own user, its own directory, no login shell. The database is the only
# state worth keeping and it is one file under here.
SERVICE_USER=ccledger
DATA_DIR=/var/lib/ccledger

say() { printf '\n==> %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "run this as root: sudo $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

say "Base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg apt-transport-https

# Ubuntu 24.04 ships Node 18 in its own repository, and better-sqlite3 does not
# merely warn below 22 — the addon segfaults the moment a database is opened.
# NodeSource is what gets a supported version.
say "Node ${NODE_MAJOR}"
node_major_now=0
if command -v node >/dev/null 2>&1; then
  node_major_now="$(node -p 'process.versions.node.split(".")[0]')"
fi
if [ "${node_major_now}" -lt "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
node --version

say "ccledger from npm"
npm install -g --no-fund --no-audit "${PACKAGE}"
CCLEDGER_BIN="$(command -v ccledger)"
"${CCLEDGER_BIN}" --version

say "Service user and data directory"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${DATA_DIR}" --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${DATA_DIR}"

# Bound to loopback when there is a proxy in front. Publishing 4318 as well
# would put an unencrypted ingest endpoint on the internet beside the TLS one.
if [ -n "${DOMAIN}" ]; then
  BIND_HOST=127.0.0.1
  PUBLIC_URL_FLAG="--public-url https://${DOMAIN}"
else
  BIND_HOST=0.0.0.0
  PUBLIC_URL_FLAG=""
  echo "no CCLEDGER_DOMAIN set: serving plain HTTP on 4318, for testing only" >&2
fi

say "systemd unit"
cat >/etc/systemd/system/ccledger.service <<UNIT
[Unit]
Description=ccledger
Documentation=https://github.com/shakibbinkabir/ccledger
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${DATA_DIR}
ExecStart=${CCLEDGER_BIN} serve --mode=vps --db ${DATA_DIR}/ccledger.db --host ${BIND_HOST} --timezone ${TIMEZONE} ${PUBLIC_URL_FLAG}
Restart=on-failure
RestartSec=5

# The admin token is printed once, on the first start, and this is where it
# goes. Reading it back is: journalctl -u ccledger | grep cca_
StandardOutput=journal
StandardError=journal

# It writes one directory and reads the clock. Nothing else.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ccledger
sleep 2
systemctl is-active ccledger

if [ -n "${DOMAIN}" ]; then
  say "Caddy"
  if ! command -v caddy >/dev/null 2>&1; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
      gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy
  fi

  # Two heredocs inside a group rather than one with a conditional in it: the
  # global block is optional, and a shell expansion that emits braces is a good
  # way to produce a config file that almost parses.
  {
    if [ -n "${ACME_EMAIL}" ]; then
      cat <<GLOBAL
{
	email ${ACME_EMAIL}
}

GLOBAL
    fi
    cat <<SITE
${DOMAIN} {
	reverse_proxy 127.0.0.1:4318

	request_body {
		max_size 8MB
	}

	encode gzip

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
	}
}
SITE
  } >/etc/caddy/Caddyfile

  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl reload caddy || systemctl restart caddy
  systemctl is-active caddy
fi

say "Done"
cat <<NEXT

  ccledger is running as a service.

    status      systemctl status ccledger
    logs        journalctl -u ccledger -f
    database    ${DATA_DIR}/ccledger.db

  The admin token was printed once, on the first start. Read it back with:

    journalctl -u ccledger | grep cca_

  Invite a teammate:

    sudo -u ${SERVICE_USER} ${CCLEDGER_BIN} invite "Their Name" --db ${DATA_DIR}/ccledger.db

NEXT
