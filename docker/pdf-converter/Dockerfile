FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui \
      fonts-liberation2 \
      fonts-noto-core \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

COPY --chown=node:node server.mjs /app/server.mjs

USER node
EXPOSE 8080

CMD ["node", "/app/server.mjs"]
