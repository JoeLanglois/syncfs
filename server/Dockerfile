FROM node:22-alpine AS admin-build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json README.md ./
COPY src ./src
RUN npm ci && npm run build
COPY server/admin/package.json server/admin/package-lock.json ./server/admin/
RUN npm --prefix server/admin ci
COPY server/admin ./server/admin
RUN npm --prefix server/admin run build

FROM golang:1.24-alpine AS server-build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/cmd ./cmd
COPY server/internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /synckv ./cmd/synckv

FROM alpine:3.22
RUN addgroup -S synckv && adduser -S -G synckv synckv && mkdir /data && chown synckv:synckv /data
WORKDIR /app
COPY --from=server-build /synckv /usr/local/bin/synckv
COPY --from=admin-build /app/server/admin/dist ./admin/dist
USER synckv
ENV HOST=0.0.0.0 PORT=8787 STORAGE_BACKEND=sqlite DATABASE_PATH=/data/synckv.sqlite ADMIN_ROOT=/app/admin/dist
VOLUME ["/data"]
EXPOSE 8787
CMD ["synckv"]
