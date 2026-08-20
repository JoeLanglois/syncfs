FROM node:22-alpine AS admin-build

WORKDIR /app

# Build the linked TypeScript client first; the admin package consumes its dist output.
COPY package.json package-lock.json tsconfig.json README.md ./
COPY src ./src
RUN npm ci && npm run build

COPY server/admin/package.json server/admin/package-lock.json ./server/admin/
RUN npm --prefix server/admin ci
COPY server/admin ./server/admin
RUN npm --prefix server/admin run build

FROM denoland/deno:alpine-2.6.4

WORKDIR /app
COPY server/deno.json ./deno.json
COPY server/src ./src
COPY --from=admin-build /app/server/admin/dist ./admin/dist

ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATABASE_PATH=/data/synckv.sqlite
VOLUME ["/data"]
EXPOSE 8787

# The same process serves the API, SSE stream, and built administration panel.
CMD ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "src/main.ts"]
