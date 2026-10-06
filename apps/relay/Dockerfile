# Build from the repo root: docker build -f apps/relay/Dockerfile -t fyv-relay .
FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/relay ./apps/relay
COPY apps/extension/package.json ./apps/extension/package.json
COPY tools/bench/package.json ./tools/bench/package.json
RUN pnpm install --frozen-lockfile --filter @fyv/relay...

FROM node:24-alpine
RUN corepack enable && addgroup -S fyv && adduser -S fyv -G fyv
WORKDIR /app
COPY --from=deps /app /app
USER fyv
ENV NODE_ENV=production PORT=8787 TRUST_PROXY=1
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["pnpm", "--filter", "@fyv/relay", "start"]
