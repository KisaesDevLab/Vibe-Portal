# syntax=docker/dockerfile:1
# Vibe Portal: one container serving the API and the built client portal.
# Built and published to ghcr.io/kisaesdevlab/vibe-portal on version tags (P40).

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/portal/package.json apps/portal/
COPY packages/db/package.json packages/db/
COPY packages/types/package.json packages/types/
COPY packages/ui/package.json packages/ui/
COPY packages/crypto/package.json packages/crypto/
# @kisaesdevlab/vibe-auth (P44) comes from GitHub Packages: the token arrives as a BuildKit
# secret and goes in a throwaway user npmrc that is gone before the layer is written.
#   docker build --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN .
RUN --mount=type=secret,id=NODE_AUTH_TOKEN,required=true \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/NODE_AUTH_TOKEN)" > /root/.npmrc \
 && pnpm install --frozen-lockfile \
 && rm -f /root/.npmrc
COPY . .
RUN --mount=type=secret,id=NODE_AUTH_TOKEN,required=true \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/NODE_AUTH_TOKEN)" > /root/.npmrc \
 && pnpm --filter @vibe-portal/portal build \
 && pnpm --filter @vibe-portal/api deploy --prod /out \
 && cp tsconfig.base.json /out/ \
 && rm -rf /out/src/__tests__ \
 && rm -f /root/.npmrc

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3101 \
    DATA_DIR=/data/portal \
    STATIC_DIR=/app/web
WORKDIR /app
# The code belongs to root: the app (uid 1000) can write only its data (QA 2026-11-09).
COPY --from=build /out /app
COPY --from=build /src/apps/portal/dist /app/web
RUN mkdir -p /data/portal && chown node:node /data/portal
USER node
VOLUME ["/data/portal"]
EXPOSE 3101
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3101/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/server.ts"]
