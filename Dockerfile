FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV MCP_HOST=0.0.0.0
ENV PORT=3000

COPY distribution.json ./distribution.json
COPY server/dist/ ./server/dist/
COPY scripts/docker-entrypoint.mjs ./scripts/docker-entrypoint.mjs
COPY scripts/lib/canonical-distribution.mjs ./scripts/lib/canonical-distribution.mjs

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

ENTRYPOINT ["node", "/app/scripts/docker-entrypoint.mjs"]
CMD ["--http"]
