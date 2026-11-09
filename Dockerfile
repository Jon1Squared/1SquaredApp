# syntax=docker/dockerfile:1
# Multi-stage immutable container build for Azure Container Apps (Model A & Model B, ADR 0024 & ADR 0030, R404)

FROM node:24-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG PLATFORM_TENANT_PACKAGE_DIR=client-not-a-law-firm
ARG PLATFORM_ENVIRONMENT=live
RUN PLATFORM_TENANT_PACKAGE_DIR=${PLATFORM_TENANT_PACKAGE_DIR} \
    PLATFORM_ENVIRONMENT=${PLATFORM_ENVIRONMENT} \
    npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/dist/jobs ./dist/jobs
COPY --from=builder --chown=node:node /app/core/schemas ./core/schemas
COPY --from=builder --chown=node:node /app/client-not-a-law-firm/config ./client-not-a-law-firm/config

USER node
EXPOSE 3000

CMD ["node", "server.js"]
