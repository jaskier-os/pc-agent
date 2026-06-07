FROM node:20-alpine

WORKDIR /app

# Copy SDK (package.json references file:./sdk after sed rewrite below)
COPY sdk/ sdk/

COPY package*.json ./

# Rewrite SDK path for Docker context (file:../../../orchestrator/sdk -> file:./sdk)
RUN sed -i 's|file:../../../orchestrator/sdk|file:./sdk|' package.json && \
    rm -f package-lock.json && \
    npm install --omit=dev

COPY src/ src/

EXPOSE 10004

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:10004/health || exit 1

CMD ["node", "src/index.js"]
