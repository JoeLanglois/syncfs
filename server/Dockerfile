FROM denoland/deno:alpine-2.6.4

WORKDIR /app
COPY deno.json ./deno.json
COPY src ./src

ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATABASE_PATH=/data/synckv.sqlite
VOLUME ["/data"]
EXPOSE 8787

# No dependency download step is necessary: the server uses Deno and node:sqlite.
CMD ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "src/main.ts"]
