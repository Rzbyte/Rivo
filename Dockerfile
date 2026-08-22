# Rivo, packaged so that running it is one command and the key never moves.
#
# The deployment model this image implements is the one the venue forces. There
# is no on-chain way to scope authority on Event Contracts (docs/SDK-FEEDBACK.md
# §9, measured by `npm run probe:operator`), so an unattended Rivo must hold a
# key that can act for its account. The answer is not to host that key for
# somebody — it is to make the account small and keep the key on the operator's
# own machine. So:
#
#   * Nothing secret is baked in. No key, no .env, no state. The image is
#     identical for every operator and safe to publish.
#   * The agent wallet is mounted at runtime, read-only, from the host.
#   * State is a mounted volume, so a container restart resumes the portfolio
#     rather than forgetting positions it owns and buying them a second time.
#
# Build:  docker build -t rivo .
# Run:    docker compose up -d          (see compose.yaml — it wires the mounts)

# --- kit stage ---------------------------------------------------------------
#
# `ec-core` ships as raw TypeScript from a repo rather than a registry package,
# and only the live execution path touches it. Fetching it in its own stage
# keeps that clone out of the final image's layer history and lets the build
# proceed without it: KIT_REF="" produces an image that runs every read-only
# command and dry runs, which is the whole product minus the trading.
FROM node:22-slim AS kit
ARG KIT_REPO=https://github.com/somnia-chain/dreamdex-bot-kit
# PINNED, not `main`.
#
# `ec-core` is not a registry package — it is raw TypeScript from a repo — so
# without a pin, an image built today and one built next month from this exact
# commit can contain different code on the path that signs transactions. That is
# the one dependency in this project that was still a moving target while
# package-lock.json pinned everything else to the byte.
#
# This is the commit Rivo was built and verified against; `npm run check:kit`
# checks the exports it calls still exist. Move it deliberately, re-run that
# check, and say so in the commit — never bump it as a side effect.
ARG KIT_REF=9718fd9fa7645a10d2dbb5bebe001f9ba0183e6d
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
# Fetch by ref rather than clone --branch: a branch name works, and so does a
# commit SHA, which `--branch` cannot take. Shallow either way.
RUN if [ -n "$KIT_REF" ]; then \
      mkdir -p dreamdex-bot-kit && cd dreamdex-bot-kit \
      && git init -q . \
      && git remote add origin "$KIT_REPO" \
      && git fetch -q --depth 1 origin "$KIT_REF" \
      && git checkout -q FETCH_HEAD \
      && rm -rf .git ; \
    else \
      mkdir -p dreamdex-bot-kit ; \
    fi

# --- deps stage --------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` against the lockfile, so an image built today and one built next month
# from the same commit contain the same dependency tree.
RUN npm ci --no-audit --no-fund
COPY --from=kit /opt/dreamdex-bot-kit /opt/dreamdex-bot-kit
# Link the kit if it was fetched. --no-save keeps package.json honest: ec-core is
# not a dependency of this repo, and a fresh clone must still `npm install`
# without it.
RUN if [ -d /opt/dreamdex-bot-kit/packages/ec-core ]; then \
      npm install --no-save --no-audit --no-fund file:/opt/dreamdex-bot-kit/packages/ec-core ; \
    fi

# --- runtime -----------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.public.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY docs ./docs

# Build the browser bundle at image build time. The page is static, so serving
# it costs nothing at runtime, and building it here means the container never
# needs a writable source tree.
RUN npm run build:public

# The runtime does not need root, and a process holding a trading key least of
# all. `node` (uid 1000) already exists in the base image.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# Where state lives. Declared so that `docker run` without an explicit mount
# still keeps a portfolio across restarts instead of silently losing it.
VOLUME ["/app/data"]

# The agent key is mounted read-only at this path; the runtime reads it and
# never writes it. RIVO_DATA_DIR is honoured by state.ts, so the portfolio lands
# on the volume rather than inside the container's writable layer.
ENV RIVO_AGENT_KEY_FILE=/run/secrets/agent.key \
    RIVO_DATA_DIR=/app/data
EXPOSE 3000

# Dry run is the default here exactly as it is on the CLI. Trading is opted into
# with `--live` in the command, never by the image.
#
# tsx is invoked by path rather than through npx: npx resolves, and on a miss
# will happily reach out to the registry, which is not something a container
# holding a trading key should ever do at start-up.
ENTRYPOINT ["node_modules/.bin/tsx"]
CMD ["src/cli/run.ts", "--capital", "25", "--profile", "balanced"]
