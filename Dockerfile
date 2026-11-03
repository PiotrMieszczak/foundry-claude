FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/mcp-server/package.json packages/mcp-server/
RUN npm ci -w @foundry-mcp/mcp-server --include-workspace-root
COPY packages/mcp-server packages/mcp-server
RUN npm run build -w @foundry-mcp/mcp-server && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/mcp-server/package.json packages/mcp-server/
COPY --from=build /app/packages/mcp-server/dist packages/mcp-server/dist
USER node
EXPOSE 3000
CMD ["node", "packages/mcp-server/dist/main.js"]
