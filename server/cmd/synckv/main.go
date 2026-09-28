package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"synckv/server/internal/httpapi"
	"synckv/server/internal/port"
	"synckv/server/internal/storage"
	"syscall"
	"time"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func main() {
	defaultPort, _ := strconv.Atoi(env("PORT", "8787"))
	host := flag.String("hostname", env("HOST", "0.0.0.0"), "listen hostname")
	portNumber := flag.Int("port", defaultPort, "listen port (0 chooses a free port)")
	backend := flag.String("storage", env("STORAGE_BACKEND", "sqlite"), "storage backend: sqlite, files, or memory")
	database := flag.String("db", env("DATABASE_PATH", "./data/synckv.sqlite"), "SQLite database path")
	files := flag.String("files", env("FILE_STORAGE_PATH", "./data/files"), "local-file storage directory or JSON path")
	admin := flag.String("admin", env("ADMIN_ROOT", defaultAdminRoot()), "built admin panel directory")
	flag.Parse()
	if *portNumber < 0 || *portNumber > 65535 {
		fatal(fmt.Errorf("invalid port: %d", *portNumber))
	}
	var driven port.Storage
	var err error
	switch *backend {
	case "sqlite":
		driven, err = storage.NewSQLite(*database)
	case "files", "file", "local":
		driven, err = storage.NewFiles(*files)
	case "memory", "inmemory":
		driven = storage.NewMemory()
	default:
		err = fmt.Errorf("unknown storage backend %q", *backend)
	}
	if err != nil {
		fatal(err)
	}
	app := httpapi.New(driven, *admin, os.Getenv("CORS_ORIGIN"))
	defer app.Close()
	listener, err := net.Listen("tcp", net.JoinHostPort(*host, strconv.Itoa(*portNumber)))
	if err != nil {
		fatal(err)
	}
	actual := listener.Addr().(*net.TCPAddr).Port
	message, _ := json.Marshal(map[string]any{"event": "listening", "hostname": *host, "port": actual})
	fmt.Println(string(message))
	server := &http.Server{Handler: app, ReadHeaderTimeout: 10 * time.Second}
	stopping := make(chan os.Signal, 1)
	signal.Notify(stopping, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stopping
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(ctx)
	}()
	if err = server.Serve(listener); err != nil && err != http.ErrServerClosed {
		fatal(err)
	}
}
func defaultAdminRoot() string {
	if _, err := os.Stat("server/admin/dist"); err == nil {
		return "server/admin/dist"
	}
	return "admin/dist"
}

func fatal(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
