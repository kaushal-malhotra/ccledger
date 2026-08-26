# ccledger — VPS mode image.
#
# Two stages, because the build needs a C++ toolchain and the runtime must not
# have one. better-sqlite3 is a native addon with no musl prebuild, so on Alpine
# it compiles from source: that pulls in python3, make and g++, which is ~200 MB
# of attack surface with no business being on a server that answers HTTP. The
# builder keeps them, the runtime copies out only the compiled result.
#
# Nothing here terminates TLS. `docker-compose.yml` puts Caddy in front, which
# is what obtains and renews the certificate; this container listens on plain
# HTTP and is never published to the host.

# --- build -------------------------------------------------------------------
FROM node:20-alpine AS build

# node-gyp's toolchain. Only ever present in this stage.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Dependencies first, and from the lockfile, so a change to application source
# does not invalidate the layer that spends minutes compiling SQLite.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Compiles both halves: Vite builds the dashboard into src/server/public, then
# esbuild emits dist/ and the asset copy step brings the dashboard and the
# schema files along with it.
RUN npm run build

# Leaves node_modules holding runtime dependencies only, with the native
# better-sqlite3 binding already built against this image's musl and Node ABI.
RUN npm prune --omit=dev

# --- runtime -----------------------------------------------------------------
FROM node:20-alpine AS runtime

# `alert reset` windows are calendar-aligned, so the zone has to be a real one.
# Node's ICU would answer for Intl alone, but a container whose `date` disagrees
# with its alerts is a debugging session nobody needs; 2 MB settles it.
RUN apk add --no-cache tzdata

# Init process. Without one, PID 1 is node, nothing reaps zombies, and — the
# part that matters here — `docker stop` on a shell-less PID 1 can miss SIGTERM,
# which is the signal `serve` shuts the database down cleanly on.
RUN apk add --no-cache tini

WORKDIR /app

# The `node` user (uid 1000) ships with the official image; there is nothing to
# create, only something to hand over. The database directory is chowned here
# rather than at run time because Docker seeds a fresh named volume from the
# image's directory, ownership included — so /data comes up writable by `node`
# on first boot without an entrypoint script running as root to fix it.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Read at run time by `--version`, `/health` and `/version`.
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

ENV NODE_ENV=production
ENV TZ=UTC

# Documentation only — `docker-compose.yml` deliberately does not publish this.
# Everything from outside arrives through Caddy.
EXPOSE 4318

VOLUME ["/data"]

# Loopback, not the published name: this asks whether the process in this
# container is answering, and routing the question through the proxy would make
# a certificate problem look like a dead application.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:4318/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/cli/index.js"]

# Overridden in docker-compose.yml, which appends the --public-url the invites
# have to carry. Useful on its own for `docker run` and for `ccledger backup`.
CMD ["serve", "--mode=vps", "--db", "/data/ccledger.db"]
