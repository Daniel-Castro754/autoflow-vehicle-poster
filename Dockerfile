FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PUBLIC_ORIGIN=http://127.0.0.1:3333
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package*.json ./
RUN mkdir -p data/uploads && chown -R node:node data
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3333/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.ts"]
