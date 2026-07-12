# Linux-coherent deployment for @trishchuk/fetch.
#
# This does NOT spoof an arbitrary OS's TCP/IP fingerprint (TTL, TCP option
# order) — that's not achievable from a container, which shares the host
# kernel rather than bringing its own. What this buys you: running on an
# actual Linux kernel (this container's, or whatever host runs it) makes the
# TCP/IP layer *genuinely* Linux, and pairing it with `platform: 'linux'` in
# `fetch()` makes the TLS/HTTP layer *declare* Linux too — so the two layers
# agree instead of a detector catching e.g. "Windows Chrome" TLS/headers
# riding on a macOS TCP stack. See ../README.md "Known limitations" for the
# TCP/IP finding this addresses, and docker/verify-tcp-coherence.js to check
# it against a live fingerprinting service after building.
#
# Build:  docker build -f docker/Dockerfile -t trishchuk-fetch:linux-coherent .
# Verify: docker run --rm trishchuk-fetch:linux-coherent
#
# IMPORTANT, verified during development: on Docker Desktop for Mac, this
# does NOT achieve TCP/IP coherence, even though the container genuinely runs
# a Linux kernel (`uname -a` inside it correctly reports Linux). Docker
# Desktop's network virtualization NATs/proxies container egress through the
# macOS host's own network stack, so the packets that actually hit the wire
# still carry the host's TCP/IP fingerprint (verified: identical TTL and TCP
# option order to a bare-macOS run, and `tcpip.os_guess` still says "macOS /
# iOS" from inside this container). This image only buys real coherence on an
# actual Linux Docker host (bare metal or a cloud VM) -- run
# verify-tcp-coherence.js there to confirm before relying on it in
# production. See ../README.md "Known limitations" for the full finding.

FROM node:24-bookworm-slim AS build

# Same package list wreq's own README documents for building against
# BoringSSL via the btls crate (cmake + go + a C/C++ toolchain + libclang).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    golang-go \
    perl \
    pkg-config \
    libclang-dev \
    clang \
    git \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src

# `pnpm install` runs the package's own "install" script (`napi build
# --platform --release`), which compiles this container's native target
# (linux-x64-gnu or linux-arm64-gnu, whichever matches the build host/
# --platform flag) and produces the .node binary alongside index.js.
RUN pnpm install --frozen-lockfile

COPY index.js index.d.ts ./

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app/package.json /app/index.js /app/index.d.ts ./
COPY --from=build /app/*.node ./
COPY docker/verify-tcp-coherence.js ./docker/verify-tcp-coherence.js

CMD ["node", "docker/verify-tcp-coherence.js"]
