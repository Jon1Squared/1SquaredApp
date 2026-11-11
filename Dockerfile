# syntax=docker/dockerfile:1
# Multi-stage immutable container build for Azure Container Apps (Model A & Model B, ADR 0024 & ADR 0030, R404)

FROM node:24-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The tenant package is a required build argument with no default, so the image never
# bakes in a client package by accident (Rules 1 and 6, R426).
ARG PLATFORM_TENANT_PACKAGE_DIR
ARG PLATFORM_ENVIRONMENT=live
RUN test -n "${PLATFORM_TENANT_PACKAGE_DIR}" || (echo 'PLATFORM_TENANT_PACKAGE_DIR build argument is required' >&2 && exit 1)
RUN PLATFORM_TENANT_PACKAGE_DIR=${PLATFORM_TENANT_PACKAGE_DIR} \
    PLATFORM_ENVIRONMENT=${PLATFORM_ENVIRONMENT} \
    npm run build

FROM node:24-bookworm-slim AS runner
WORKDIR /app

ARG PLATFORM_TENANT_PACKAGE_DIR
RUN test -n "${PLATFORM_TENANT_PACKAGE_DIR}" || (echo 'PLATFORM_TENANT_PACKAGE_DIR build argument is required' >&2 && exit 1)

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/dist/jobs ./dist/jobs
COPY --from=builder --chown=node:node /app/core/schemas ./core/schemas
COPY --from=builder --chown=node:node /app/${PLATFORM_TENANT_PACKAGE_DIR}/config ./${PLATFORM_TENANT_PACKAGE_DIR}/config

USER node
EXPOSE 3000

CMD ["node", "server.js"]
