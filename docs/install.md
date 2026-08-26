# Installing the ccledger server

One person on the team runs the server. Everyone else runs
[`ccledger setup`](setup.md) once and forgets about it.

There are two ways to run it.

|               | Laptop mode                                            | VPS mode                           |
| ------------- | ------------------------------------------------------ | ---------------------------------- |
| Who it is for | A team in one office or on one VPN                     | Anyone remote                      |
| Transport     | Plain HTTP over the LAN                                | HTTPS, certificate handled for you |
| Discovery     | Advertised as `ccledger.local` over mDNS               | A domain you own                   |
| Uptime        | Only while that laptop is awake and on the network     | Always                             |
| Setup         | `npm install -g @thisissbk/ccledger && ccledger serve` | `docker compose up -d`             |

On AWS, the cheapest always-on option is a Lightsail instance at $5 a month;
[deploy-aws.md](deploy-aws.md) is that path end to end, and it installs from
npm rather than Docker because the $5 machine has too little memory to build
the image.

Laptop mode is the fast way to find out whether the thing is useful to you.
Move to VPS mode when it is, or immediately if anyone on the team works
remotely — laptop mode sends bearer tokens over unencrypted HTTP and should
only ever cross a network you trust.

Both modes hold everything in one SQLite file. Moving from one to the other is
copying that file, though tokens are tied to the database, so teammates re-run
`setup` with a new invite if you start a fresh one.

---

## Laptop mode

### 1. Install

Node 22 or newer is required. `better-sqlite3` declares it, and on Node 20 the
native addon crashes the process as soon as a database is opened.

The package is scoped, `@thisissbk/ccledger`, because npm holds the unscoped
name for an unrelated project. The command it installs is plain `ccledger`.

```console
$ node --version
v22.14.0

$ npm install -g @thisissbk/ccledger

added 79 packages in 8s

$ ccledger --version
0.1.0
```

### 2. Start the server

```console
$ ccledger serve

ccledger 0.1.0 · laptop mode · listening on http://localhost:4318

  ingest      http://ccledger.local:4318/v1/logs
  health      http://ccledger.local:4318/health
  database    /home/you/ccledger.db
  alert reset Europe/Berlin  (calendar day and week boundaries)

  Advertised over mDNS as ccledger.local — teammates need no setup for it.
  Teammates on this network reach ccledger at http://ccledger.local:4318
  If that does not reach them, try http://192.168.1.24:4318

  WARNING  laptop mode serves plain HTTP. Tokens and telemetry cross the
           network unencrypted and anyone on it can read them. Use this
           mode only on a network you trust; run --mode=vps behind TLS
           for anything else.

  Invite a teammate:  ccledger invite <name>

  Admin token created.
  Only its hash is stored, so this is the one and only time it is shown.
  Save it somewhere before closing this terminal.

      cca_SVhcViVryfFYKGLuucXabK76LCAy4FGc

  Dashboard   http://localhost:4318/#token=cca_SVhcViVryfFYKGLuucXabK76LCAy4FGc
```

Read that output line by line the first time.

- **The database is created in the directory you ran the command from.** Pass
  `--db /some/where/ccledger.db` if you want it elsewhere. Run `serve` from the
  same directory every time, or always pass `--db`, otherwise you will start a
  second, empty database and wonder where everyone went.
- **The admin token is shown once.** Only its SHA-256 is stored. Put it in your
  password manager now. If you lose it, `ccledger serve --rotate-admin-token`
  issues a new one and invalidates the old.
- **The dashboard URL carries the token in the fragment**, after the `#`. A
  fragment is never sent to the server, so the token stays out of access logs
  and out of `Referer` headers.
- **`alert reset` is the timezone** that alert day and week windows are aligned
  to. It defaults to this machine's zone on the first run and is then stored.
  Set it deliberately with `--timezone Europe/Berlin` — changing it later moves
  every window boundary, which can let a budget that already fired this week
  fire again.

### If it prints several addresses instead of one

mDNS does not work on every network, and a development machine usually has
WSL, Docker or Hyper-V adapters alongside the real one. When ccledger cannot
tell which address your teammates share a network with, it refuses to guess:

```console
$ ccledger serve

ccledger 0.1.0 · laptop mode · listening on http://localhost:4318

  ingest      http://localhost:4318/v1/logs
  health      http://localhost:4318/health
  database    /home/you/ccledger.db
  alert reset Europe/Berlin  (calendar day and week boundaries)

  mDNS is not available here, so ccledger.local was not advertised.
  This machine has more than one address and ccledger cannot tell which of
  them teammates can reach, so invites carry none of them. Restart with the
  one that is on their network:

      ccledger serve --public-url http://172.19.144.1:4318
      ccledger serve --public-url http://192.168.1.24:4318
```

Pick the one on your actual LAN — usually the `192.168.x.x` or `10.x.x.x`
address your router hands out — and restart with it. The choice is written to
the database, so later runs and every invite pick it up without the flag.

### 3. Check it answers

```console
$ curl -s http://localhost:4318/health
{"status":"ok","version":"0.1.0","uptimeSeconds":60}
```

From a teammate's machine, against the address you are advertising:

```console
$ curl -s http://ccledger.local:4318/health
{"status":"ok","version":"0.1.0","uptimeSeconds":180}
```

If that second one hangs or refuses, nothing else will work. It is a firewall
on the server machine nine times out of ten — Windows in particular prompts
once for private-network access and denies it if the prompt is dismissed.

### 4. Invite your team

One invite per person. It bundles the endpoint and a single-use code into one
string so there is exactly one thing to paste.

```console
$ ccledger invite "Alice Chen"

Invite for Alice Chen

  endpoint    http://ccledger.local:4318
  join code   57TJ-576E-95EK
  expires     2026-08-27T05:57:17.525Z

Send them this line:

  npx @thisissbk/ccledger setup --code eyJ2IjoxLCJlbmRwb2ludCI6Imh0dHA6Ly9jY2xlZGdlci5sb2NhbDo0MzE4IiwiY29kZSI6IjU3VEotNTc2RS05NUVLIiwibmFtZSI6IkFsaWNlIENoZW4ifQ

The code works once and expires in 24 hours.

ccledger: this endpoint is plain HTTP — the token it hands out will cross the network unencrypted, so only send this invite over a network you trust
```

Send them that `npx` line. What happens on their side is in
[setup.md](setup.md).

`ccledger invite` needs the same `--db` as `serve`, and it reads the endpoint
`serve` recorded, so it can be run in another terminal while the server is up.
If you invite several people and lose track, the next invite tells you:

```
Still unclaimed from earlier: 2 (Marco Ruiz, Priya Nair).
```

### 5. Keep it running

`ccledger serve` runs in the foreground and stops when you close the terminal,
which is fine for a trial and not fine after that. Anything that keeps a
process alive will do. On macOS, a `launchd` agent; on Linux, a systemd user
unit:

```ini
# ~/.config/systemd/user/ccledger.service
[Unit]
Description=ccledger
After=network-online.target

[Service]
ExecStart=/usr/bin/env ccledger serve --db %h/ccledger.db --timezone Europe/Berlin
Restart=on-failure

[Install]
WantedBy=default.target
```

```console
$ systemctl --user enable --now ccledger
$ systemctl --user is-active ccledger
active
```

Note that the admin token is printed on the first run only, so it will be in
the service log rather than on your screen. Run `serve` once by hand first and
save the token, or read it back with `journalctl --user -u ccledger | grep cca_`.

---

## VPS mode

Anything more than a trial, and anything with a remote teammate, should run
this way. Caddy sits in front and gets a certificate from Let's Encrypt on the
first request, so there is no certbot and no renewal to remember.

### What you need

- A host with Docker and the Compose plugin, ports 80 and 443 reachable from
  the internet.
- A domain whose A record already points at that host. Caddy proves control of
  the name over port 80 and cannot do that before DNS resolves.

### 1. Get the repository onto the host

The image is built from source, so the compose file needs the checkout.

```console
$ git clone https://github.com/shakibbinkabir/ccledger.git
Cloning into 'ccledger'...
remote: Enumerating objects: 412, done.
Receiving objects: 100% (412/412), 1.21 MiB | 4.02 MiB/s, done.

$ cd ccledger/docker
```

### 2. Fill in the two values

```console
$ cp .env.example .env
$ cat .env
CCLEDGER_DOMAIN=ccledger.example.com
CCLEDGER_ACME_EMAIL=you@example.com
CCLEDGER_TIMEZONE=UTC
```

Edit it. `CCLEDGER_DOMAIN` is the name, with no scheme and no trailing slash.
`CCLEDGER_ACME_EMAIL` is where Let's Encrypt sends expiry warnings, which only
matters when renewal has stopped working — so make it an address somebody
reads. `CCLEDGER_TIMEZONE` is what alert day and week windows align to; set it
once, at install, for the reason given above.

### 3. Bring it up

```console
$ docker compose up -d
[+] Building 74.3s (18/18) FINISHED
[+] Running 5/5
 ✔ Network ccledger_ccledger     Created
 ✔ Volume "ccledger_ccledger-data"  Created
 ✔ Volume "ccledger_caddy-data"     Created
 ✔ Container ccledger-ccledger-1  Started
 ✔ Container ccledger-caddy-1     Started

$ docker compose ps
NAME                  IMAGE             STATUS                   PORTS
ccledger-caddy-1      caddy:2-alpine    Up 20 seconds            0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
ccledger-ccledger-1   ccledger-ccledger Up 21 seconds (healthy)  4318/tcp
```

The first build compiles `better-sqlite3` from source and takes a few minutes.
`4318/tcp` with no host mapping is deliberate: the only route in is Caddy, so
there is no unencrypted ingest endpoint on the public internet.

### 4. Get the admin token

It is printed once, on the first boot, into the container log.

```console
$ docker compose logs ccledger | grep -A2 "Admin token"
ccledger-ccledger-1  |   Admin token created.
ccledger-ccledger-1  |   Only its hash is stored, so this is the one and only time it is shown.
ccledger-ccledger-1  |   Save it somewhere before closing this terminal.
ccledger-ccledger-1  |
ccledger-ccledger-1  |       cca_J9ThZ049ArjrV57rxGmtk1eUPZ5AeW3k
```

Save it, then open `https://ccledger.example.com/#token=cca_…`.

If the log has already rotated away, issue a new one:

```console
$ docker compose run --rm ccledger serve --mode=vps --db /data/ccledger.db --rotate-admin-token
```

That prints a token and then sits there serving; stop it with Ctrl+C once you
have copied it. The old token stops working the moment the new one is issued.

### 5. Check TLS and invite

```console
$ curl -s https://ccledger.example.com/health
{"status":"ok","version":"0.1.0","uptimeSeconds":94}

$ docker compose exec ccledger node dist/cli/index.js invite "Alice Chen" --db /data/ccledger.db

Invite for Alice Chen

  endpoint    https://ccledger.example.com
  join code   BWHW-5F3V-BRXN
  expires     2026-08-27T09:14:02.118Z

Send them this line:

  npx @thisissbk/ccledger setup --code eyJ2IjoxLCJlbmRwb2ludCI6Imh0dHBzOi8vY2NsZWRnZXIuZXhhbXBsZS5jb20iLCJjb2RlIjoiQldIVy01RjNWLUJSWE4iLCJuYW1lIjoiQWxpY2UgQ2hlbiJ9

The code works once and expires in 24 hours.
```

No plain-HTTP warning this time, because the endpoint is HTTPS.

The domain is baked into the container's `--public-url`, and `serve` writes it
to the database on every boot, so every invite carries it without you retyping
it.

### Updating

```console
$ git pull
$ docker compose up -d --build
[+] Running 2/2
 ✔ Container ccledger-ccledger-1  Started
 ✔ Container ccledger-caddy-1     Running
```

Migrations run on boot. The database is a named volume and survives the
rebuild.

---

## Backups

The database is the only state worth keeping. Copy it with `ccledger backup`,
which uses SQLite's online backup API and is safe while the server is running:

```console
$ ccledger backup ~/backups/ccledger-2026-08-26.db
backed up /home/you/ccledger.db
        to /home/you/backups/ccledger-2026-08-26.db  (104.0 KiB)
```

In VPS mode, run it inside the container and copy the result out:

```console
$ docker compose exec ccledger \
    node dist/cli/index.js backup /data/ccledger-2026-08-26.db --db /data/ccledger.db
backed up /data/ccledger.db
        to /data/ccledger-2026-08-26.db  (312.0 KiB)

$ docker compose cp ccledger:/data/ccledger-2026-08-26.db .
```

Do not back it up by copying the volume's files while the server is running.
The database runs in WAL mode, so the committed state spans `ccledger.db` and
`ccledger.db-wal`, and a file-level copy catches the two out of step. Restoring
is the reverse: stop the server, put the file where `--db` points, start it.

## Server flags

| Flag                   | Default                     | What it does                                                              |
| ---------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `-p, --port <number>`  | `4318`                      | Port to listen on. 4318 is the OTLP/HTTP default                          |
| `-d, --db <path>`      | `./ccledger.db`             | The SQLite file. Created if absent, migrated on every boot                |
| `-H, --host <address>` | `0.0.0.0`                   | Interface to bind                                                         |
| `-m, --mode <mode>`    | `laptop`                    | `laptop` or `vps`. Decides the warnings, mDNS, and the default public URL |
| `--public-url <url>`   | guessed                     | The base URL invites carry. Required in VPS mode                          |
| `--name <label>`       | the machine name            | What a teammate sees when they join                                       |
| `--timezone <zone>`    | stored, then this machine's | IANA zone alert windows reset on                                          |
| `--rotate-admin-token` | off                         | Issue a new admin token and invalidate the current one                    |

`CCLEDGER_LOG_LEVEL` sets the request log level (`fatal`, `error`, `warn`,
`info`, `debug`, `trace`, `silent`); it defaults to `info`.

## Endpoints

| Path            | Auth              | Purpose                                                       |
| --------------- | ----------------- | ------------------------------------------------------------- |
| `POST /v1/logs` | member token      | OTLP ingest. Accepts gzip. 400 on a malformed body, never 500 |
| `GET /health`   | none              | Liveness. Status, version, uptime                             |
| `GET /version`  | none              | Build version alone, for checking a deploy landed             |
| `POST /join`    | a live join code  | Spends a code, returns a member token                         |
| `POST /leave`   | member token      | A teammate giving their own token up                          |
| `GET /api/*`    | admin token       | Everything the dashboard reads                                |
| `GET /`         | none for the page | The dashboard. It asks for the admin token itself             |

## Next

- Your teammates: [setup.md](setup.md)
- Nothing showing up: [troubleshoot.md](troubleshoot.md)
- What is actually being sent: [privacy.md](privacy.md)
