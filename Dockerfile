# build stage: compile the server and the ui
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY . .
RUN npm --prefix web run build && npx tsc -p tsconfig.build.json

# runtime stage: production dependencies only, runs as a non-root user
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY knowledge-base ./knowledge-base
COPY evals ./evals
RUN mkdir -p .cache data && chown -R node:node .cache data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1
CMD ["node", "dist/src/index.js"]
