FROM node:24.22.1-alpine AS gateway-node-builder

WORKDIR /app

# copy package metadata first, so dependency installation can be cached.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# copy gateway code and build inside the container, then remove dev dependencies
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.19.0-alpine

RUN apk add --no-cache curl

ENV NODE_ENV=production
WORKDIR /app

# copy in all files needed to run the app
COPY --from=gateway-node-builder --chown=node:node /app/package.json ./package.json
COPY --from=gateway-node-builder --chown=node:node /app/node_modules ./node_modules
COPY --from=gateway-node-builder --chown=node:node /app/dist ./dist
COPY --chown=node:node static ./static

# npm is not required by the running service - remove to reduce vulnerable dependencies
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

# Prep the writable file store mount point (owned by the app user so it has write permissions)
RUN mkdir -p /app/files \
    && chown node:node /app/files

# define health check for container: /health route will return 200 if healthy
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=15 \
  CMD /bin/sh -c 'curl -sf http://localhost:$PORT/health || exit 1'

# run app as node user
USER node
CMD ["node", "dist/main.js"]
