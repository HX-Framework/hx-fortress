# TODO(prod): pin the base image by digest — oven/bun:1.3.14@sha256:<digest> —
# so a moved tag can't swap the toolchain under a rebuild (supply-chain, M-11).
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
# The console workspace is installed from its manifests alone, before the
# sources land, so editing app code does not re-resolve its dependency tree.
COPY ui/package.json ui/bun.lock ui/
RUN cd ui && bun install --frozen-lockfile
COPY . .
# build:ui -> gen:ui -> compile, the same pipeline the workflows run, so the
# image embeds assets built from these sources rather than anything copied in.
RUN bun run build            # produces ./dist/hx-fortress (compiled)

# TODO(prod): pin the base image by digest — oven/bun:1.3.14-slim@sha256:<digest>.
FROM oven/bun:1.3.14-slim
WORKDIR /app

# Pull the latest Debian security patches into the runtime layer so the image
# doesn't ship fixable OS-package CVEs the base tag baked in (Trivy gate, plan
# §2.1). CVEs Debian hasn't fixed yet are handled by `ignore-unfixed` in the
# scan step — we can't patch what upstream hasn't released.
RUN apt-get update \
  && apt-get -y upgrade \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist/hx-fortress /usr/local/bin/hx-fortress

# Run as a non-root system user (M-11). Two reasons: the embedded Postgres
# refuses to run as uid 0 (initdb/postgres abort as root), and dropping root
# shrinks the blast radius of any RCE in a downloaded/loaded artifact. /data is
# the writable state volume, owned by the fortress user.
RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin fortress \
  && mkdir -p /data \
  && chown -R fortress:fortress /data

# Persist config.json / credentials.json / signing-key on a mounted volume.
# NOTE: a bind-mounted /data keeps the host's ownership — mount it writable by
# uid 10001 (or use a named volume, which inherits the image's ownership).
ENV FORTRESS_ROOT=/data
# HOME is the OTHER root. credentials.json lives under $HOME/.let/session-vault/,
# so an unset HOME puts the organization's bucket keys in the container's
# writable layer — which a plain image upgrade discards. Naming it /data puts it
# on the same volume as everything else the fortress must not lose.
#
# THE UPGRADE FROM AN OLDER IMAGE IS NOT AUTOMATIC. The daemon does check the
# older homes (/root, /) once at boot and adopts what it finds — but VOLUME is
# ["/data"], so on a container enrolled interactively under an older image those
# paths lived in the writable layer, and replacing the image discards them before
# the new one ever looks. Enrollment survives an upgrade only when the
# pre-upgrade $HOME was already on the volume. Copy /root/.let (or /.let) to
# /data/.let BEFORE replacing the image — see the container section of
# RELEASING.md.
ENV HOME=/data
VOLUME ["/data"]
# 8787 is the ingest gateway; 8788 is the administration console. Publish the
# console to the host's LOOPBACK (-p 127.0.0.1:8788:8788) — an EXPOSE is
# documentation, and the port it documents carries a password.
EXPOSE 8787 8788
USER fortress
# FORTRESS_PUBLIC_URL + storage config supplied at runtime (-e / compose).
# When your orchestrator restarts crashed containers (compose `restart:`, k8s),
# set FORTRESS_STORE_EXIT_ON_WEDGE=on so a wedged storage pool self-heals via
# a supervised restart instead of running degraded.
# TLS terminates at the customer ingress in front of this container.
#
# container-run rather than host: the console is a SEPARATE process (a stopped
# daemon cannot serve its own Start button), and an image has one entrypoint. It
# refuses to run anywhere it is not pid 1 — pid 1 is what receives the runtime's
# SIGTERM, and a daemon killed by the grace timeout never writes its last status,
# never drains its audit spool and never stops its cluster cleanly.
ENTRYPOINT ["hx-fortress", "container-run"]
