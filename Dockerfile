# Each image this file builds on is named by its tag AND by the digest of its
# image index. The digest is what a build pulls, so a tag that is moved later
# cannot change what a rebuild starts from. The tag says which image it is to a
# person. The index holds linux/amd64 and linux/arm64, so one line serves both.
#
# To move to a newer image, change the tag and the digest together.
# `docker buildx imagetools inspect <image>:<tag>` prints the index's digest.
# A release's file names these three images with their digests
# (scripts/release-file.ts), and a test fails when one loses its digest
# (test/release-file.test.ts).
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
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

# The data runner: the program HX Fortress starts beside itself to do one job on
# a database. Its source is data-runner/, a Go module of its own. The script is
# the one a release runs, so the image's program is the file a release
# publishes as hx-fortress-data-runner-linux-<arch>: CI compares the two.
# The image's Go is the version data-runner/go.mod names
# (test/data-runner-build.test.ts holds the two together). Nothing proposes a
# newer Go image: when that version changes, the tag and the digest here
# change with it.
FROM golang:1.27.4-trixie@sha256:430985542100b871e108ccc00e8dcc5eef08ca14ee5825e98ebf563d8ffec4ee AS data-runner
# What `data-runner version` prints. A release passes its version and commit.
ARG HX_FORTRESS_VERSION=dev
# BuildKit sets this to the architecture the image is built for.
ARG TARGETARCH
WORKDIR /src
COPY scripts/build-data-runner.sh scripts/build-data-runner.sh
COPY data-runner/ data-runner/
RUN bash scripts/build-data-runner.sh /out "${HX_FORTRESS_VERSION}" "linux/${TARGETARCH:-$(go env GOARCH)}" \
  && mv /out/hx-fortress-data-runner-linux-* /out/data-runner

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
WORKDIR /app

# Pull the latest Debian security patches into the runtime layer so the image
# doesn't ship fixable OS-package CVEs the base tag baked in (Trivy gate, plan
# §2.1). CVEs Debian hasn't fixed yet are handled by `ignore-unfixed` in the
# scan step — we can't patch what upstream hasn't released.
#
# ca-certificates: the data runner checks a database server's certificate
# against the system's certificate authorities when a connection checks the
# certificate and names no authority of its own. The package is named here so
# that the image holds them whatever its base image holds.
RUN apt-get update \
  && apt-get -y upgrade \
  && apt-get install -y --no-install-recommends ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist/hx-fortress /usr/local/bin/hx-fortress
# The data runner beside it, owned by root: the daemon's user can run the file
# and cannot replace it. FORTRESS_DATA_RUNNER names its path for the module
# host, which will read it when it starts the program. Nothing reads it yet.
COPY --from=data-runner /out/data-runner /usr/local/bin/data-runner
ENV FORTRESS_DATA_RUNNER=/usr/local/bin/data-runner

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
