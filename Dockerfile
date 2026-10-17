# verify402 — single-container deployment.
# Works on Render, Fly.io, Railway, a VPS, anywhere a container goes.
#
# The server reads all secrets from the environment; nothing is baked in.
# Required in production:
#   X402_MODE=mainnet
#   FACILITATOR_URL=...        (a mainnet facilitator; the server refuses
#                               to start without one in mainnet mode)
#   PAY_TO_EVM / PAY_TO_SVM    (defaults are already the owner's wallets)
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src/ src/

# Non-root, no shell history, no surprises.
USER node

ENV PORT=4021
EXPOSE 4021

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "src/server.mjs"]
