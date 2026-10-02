FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV MCP_HOST=0.0.0.0

COPY distribution.json ./distribution.json
COPY server/dist/ ./server/dist/
COPY scripts/docker-entrypoint.mjs ./scripts/docker-entrypoint.mjs
COPY scripts/lib/canonical-distribution.mjs ./scripts/lib/canonical-distribution.mjs
COPY shared/canonical-distribution.mjs ./shared/canonical-distribution.mjs

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const port = process.env.PORT || process.env.MCP_PORT || '3000'; const host = (process.env.MCP_ALLOWED_HOSTS || '127.0.0.1').split(',').map(value => value.trim()).find(Boolean) || '127.0.0.1'; require('node:http').get({ hostname: '127.0.0.1', port, path: '/health', headers: { Host: host } }, response => { response.resume(); response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1)); }).on('error', () => process.exit(1))"

ENTRYPOINT ["node", "/app/scripts/docker-entrypoint.mjs"]
CMD ["--http"]
