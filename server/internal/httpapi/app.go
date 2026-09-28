// Package httpapi is the driving HTTP adapter. It translates the wire protocol
// into pure core commands and delegates durability to a storage port.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"synckv/server/internal/core"
	"synckv/server/internal/port"
	"time"
)

type notification struct {
	change core.Change
	prefix string
}
type listener struct {
	prefixes []string
	client   string
	ch       chan notification
}
type Hub struct {
	mu        sync.Mutex
	listeners map[*listener]struct{}
}

func NewHub() *Hub { return &Hub{listeners: map[*listener]struct{}{}} }
func (h *Hub) add(prefixes []string, client string) (*listener, func()) {
	l := &listener{prefixes: prefixes, client: client, ch: make(chan notification, 64)}
	h.mu.Lock()
	h.listeners[l] = struct{}{}
	h.mu.Unlock()
	return l, func() {
		h.mu.Lock()
		if _, ok := h.listeners[l]; ok {
			delete(h.listeners, l)
			close(l.ch)
		}
		h.mu.Unlock()
	}
}
func (h *Hub) publish(changes []core.Change) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range changes {
		for l := range h.listeners {
			if c.Origin != "" && c.Origin == l.client {
				continue
			}
			if p, ok := matchingPrefix(l.prefixes, c.Key); ok {
				select {
				case l.ch <- notification{c, p}:
				default:
				}
			}
		}
	}
}

type App struct {
	store      port.Storage
	hub        *Hub
	adminRoot  string
	corsOrigin string
}

func New(store port.Storage, adminRoot, corsOrigin string) *App {
	if corsOrigin == "" {
		corsOrigin = "*"
	}
	return &App{store: store, hub: NewHub(), adminRoot: adminRoot, corsOrigin: corsOrigin}
}
func (a *App) Close() error { return a.store.Close() }

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	if err := a.route(w, r); err != nil {
		var e *core.Error
		if errors.As(err, &e) {
			writeJSON(w, e.Status, map[string]any{"error": e.Message})
		} else {
			fmt.Fprintln(os.Stderr, err)
			writeJSON(w, 500, map[string]any{"error": "Internal server error"})
		}
	}
}
func (a *App) cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", a.corsOrigin)
	h.Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type, If-Match, If-None-Match, Idempotency-Key, Last-Event-ID, X-SyncKv-Client-Id")
	h.Set("Access-Control-Expose-Headers", "ETag")
}

func (a *App) route(w http.ResponseWriter, r *http.Request) error {
	path := r.URL.Path
	if path == "/admin" {
		w.Header().Set("Location", "/admin/")
		w.WriteHeader(308)
		return nil
	}
	if strings.HasPrefix(path, "/admin/") && (r.Method == "GET" || r.Method == "HEAD") {
		return a.admin(w, r)
	}
	if path == "/health" && r.Method == "GET" {
		writeJSON(w, 200, map[string]bool{"ok": true})
		return nil
	}
	if path == "/v1/events" && r.Method == "GET" {
		return a.events(w, r)
	}
	if path == "/v1/keys" && r.Method == "GET" {
		return a.list(w, r)
	}
	if path == "/v1/values/read" && r.Method == "POST" {
		return a.readMany(w, r)
	}
	if path == "/v1/transactions" && r.Method == "POST" {
		return a.transaction(w, r)
	}
	if path == "/v1/mutations" && r.Method == "POST" {
		return a.mutations(w, r)
	}
	if path != "/v1/values" {
		return core.Fail(404, "Route not found")
	}
	return a.value(w, r)
}

func (a *App) snapshot(ctx context.Context) (core.State, error) { return a.store.Snapshot(ctx) }
func (a *App) list(w http.ResponseWriter, r *http.Request) error {
	s, err := a.snapshot(r.Context())
	if err != nil {
		return err
	}
	entries, etag := core.List(s, r.URL.Query().Get("prefix"))
	w.Header().Set("ETag", quote(etag))
	if parseETag(r.Header.Get("If-None-Match")) == etag {
		w.WriteHeader(304)
		return nil
	}
	writeJSON(w, 200, map[string]any{"entries": entries, "etag": etag})
	return nil
}
func (a *App) readMany(w http.ResponseWriter, r *http.Request) error {
	var body struct {
		Keys []string `json:"keys"`
	}
	if err := readObject(r, &body); err != nil {
		return err
	}
	if body.Keys == nil || len(body.Keys) > 1000 {
		return core.Fail(400, "Invalid keys batch")
	}
	s, err := a.snapshot(r.Context())
	if err != nil {
		return err
	}
	out := make([]map[string]any, 0, len(body.Keys))
	for _, k := range body.Keys {
		if k == "" {
			return core.Fail(400, "key is required")
		}
		v, e := core.Get(s, k)
		if e != nil {
			return e
		}
		out = append(out, map[string]any{"key": k, "value": v.JSON, "etag": v.ETag})
	}
	writeJSON(w, 200, out)
	return nil
}
func (a *App) value(w http.ResponseWriter, r *http.Request) error {
	key := r.URL.Query().Get("key")
	if key == "" {
		return core.Fail(400, "key is required")
	}
	if r.Method == "GET" {
		s, e := a.snapshot(r.Context())
		if e != nil {
			return e
		}
		v, e := core.Get(s, key)
		if e != nil {
			return e
		}
		w.Header().Set("ETag", quote(v.ETag))
		writeJSON(w, 200, map[string]any{"value": v.JSON, "etag": v.ETag})
		return nil
	}
	if r.Method != "PUT" && r.Method != "DELETE" {
		return core.Fail(405, "Method not allowed")
	}
	id := r.Header.Get("Idempotency-Key")
	if id == "" {
		return core.Fail(400, "Idempotency-Key is required")
	}
	match := parseETag(r.Header.Get("If-Match"))
	none := r.Header.Get("If-None-Match") == "*"
	s, e := a.snapshot(r.Context())
	if e != nil {
		return e
	}
	_, exists := s.Values[key]
	if r.Method == "DELETE" && !exists {
		return core.Fail(404, "Key not found: %s", key)
	}
	if match == "" && !none {
		return core.Fail(428, "Mutation requires a precondition")
	}
	op := core.Operation{Key: key, BaseETag: match, RequireAbsent: none}
	if r.Method == "PUT" {
		var b struct {
			Value json.RawMessage `json:"value"`
		}
		if e = readObject(r, &b); e != nil {
			return e
		}
		if b.Value == nil {
			return core.Fail(400, "Body must contain value")
		}
		op.Type = "set"
		op.Value, e = core.CompactJSON(b.Value)
		if e != nil {
			return core.Fail(400, "Value is not JSON serializable")
		}
	} else {
		op.Type = "delete"
	}
	fingerprint := r.Method + "\n" + key + "\n" + match + "\n" + r.Header.Get("If-None-Match") + "\n" + string(op.Value)
	return a.execute(w, r, id, fingerprint, []core.Operation{op}, true)
}

type wireOperation struct {
	Type     string          `json:"type"`
	Key      string          `json:"key"`
	Value    json.RawMessage `json:"value"`
	BaseETag string          `json:"baseEtag"`
}

func (a *App) transaction(w http.ResponseWriter, r *http.Request) error {
	var b struct {
		Operations []wireOperation `json:"operations"`
	}
	if e := readObject(r, &b); e != nil {
		return e
	}
	if b.Operations == nil || len(b.Operations) > 500 {
		return core.Fail(400, "Invalid transaction operations")
	}
	ops := make([]core.Operation, 0, len(b.Operations))
	seen := map[string]bool{}
	for _, raw := range b.Operations {
		if raw.Key == "" {
			return core.Fail(400, "key is required")
		}
		if seen[raw.Key] {
			return core.Fail(400, "A transaction may operate on each key only once")
		}
		seen[raw.Key] = true
		if raw.Type != "set" && raw.Type != "delete" {
			return core.Fail(400, "Unknown transaction operation")
		}
		if raw.Type == "set" && raw.Value == nil {
			return core.Fail(400, "Unknown transaction operation")
		}
		ops = append(ops, core.Operation{Type: raw.Type, Key: raw.Key, Value: raw.Value, BaseETag: raw.BaseETag, RequireAbsent: raw.BaseETag == "" && raw.Type == "set"})
	}
	id := r.Header.Get("Idempotency-Key")
	if id == "" {
		return core.Fail(400, "Idempotency-Key is required")
	}
	encoded, _ := json.Marshal(b.Operations)
	return a.execute(w, r, id, "TRANSACTION\n"+string(encoded), ops, false)
}
func (a *App) execute(w http.ResponseWriter, r *http.Request, id, fingerprint string, ops []core.Operation, singleResponse bool) error {
	var changes []core.Change
	result, err := a.store.Update(r.Context(), func(s core.State) (core.State, core.Result, error) {
		previous := core.LatestChangeID(s)
		next, result, err := core.Apply(s, core.Command{ID: id, Fingerprint: fingerprint, Operations: ops, Origin: r.Header.Get("X-SyncKv-Client-Id"), SingleResponse: singleResponse})
		if err == nil && !result.Replay {
			changes = core.ChangesAfter(next, previous)
		}
		return next, result, err
	})
	if err != nil {
		return err
	}
	a.hub.publish(changes)
	writeRawJSON(w, result.Status, result.Body)
	return nil
}

func (a *App) mutations(w http.ResponseWriter, r *http.Request) error {
	var b struct {
		Mutations []struct {
			wireOperation
			MutationID string `json:"mutationId"`
		} `json:"mutations"`
	}
	if e := readObject(r, &b); e != nil {
		return e
	}
	if b.Mutations == nil || len(b.Mutations) > 500 {
		return core.Fail(400, "Invalid mutation batch")
	}
	results := make([]any, 0, len(b.Mutations))
	for _, m := range b.Mutations {
		if m.Key == "" || m.MutationID == "" {
			results = append(results, map[string]any{"ok": false, "status": 400, "key": m.Key, "message": "Invalid mutation"})
			continue
		}
		op := core.Operation{Type: m.Type, Key: m.Key, Value: m.Value, BaseETag: m.BaseETag, RequireAbsent: m.BaseETag == ""}
		var changes []core.Change
		result, e := a.store.Update(r.Context(), func(s core.State) (core.State, core.Result, error) {
			encoded, _ := json.Marshal(m)
			previous := core.LatestChangeID(s)
			next, result, err := core.Apply(s, core.Command{ID: m.MutationID, Fingerprint: string(encoded), Operations: []core.Operation{op}, Origin: r.Header.Get("X-SyncKv-Client-Id"), SingleResponse: true})
			if err == nil && !result.Replay {
				changes = core.ChangesAfter(next, previous)
			}
			return next, result, err
		})
		if e != nil {
			var ce *core.Error
			if errors.As(e, &ce) {
				results = append(results, map[string]any{"ok": false, "status": ce.Status, "key": m.Key, "message": ce.Message})
				continue
			}
			return e
		}
		a.hub.publish(changes)
		var value any
		_ = json.Unmarshal(result.Body, &value)
		results = append(results, map[string]any{"ok": true, "result": value})
	}
	writeJSON(w, 200, results)
	return nil
}

func (a *App) events(w http.ResponseWriter, r *http.Request) error {
	prefixes := r.URL.Query()["prefix"]
	if len(prefixes) == 0 {
		return core.Fail(400, "At least one prefix is required")
	}
	// Subscribe before taking the replay snapshot. Notifications already present in
	// that snapshot are ignored below, closing the concurrent connect/write gap.
	l, remove := a.hub.add(prefixes, r.URL.Query().Get("clientId"))
	defer remove()
	s, e := a.snapshot(r.Context())
	if e != nil {
		return e
	}
	upper := core.LatestChangeID(s)
	last := upper
	if raw := r.Header.Get("Last-Event-ID"); raw != "" {
		last, e = strconv.ParseInt(raw, 10, 64)
		if e != nil || last < 0 {
			return core.Fail(400, "Invalid Last-Event-ID")
		}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		return errors.New("streaming unsupported")
	}
	w.WriteHeader(200)
	flusher.Flush()
	for _, c := range core.ChangesAfter(s, last) {
		if c.Origin == l.client && l.client != "" {
			continue
		}
		if p, ok := matchingPrefix(prefixes, c.Key); ok {
			sendEvent(w, c.ID, p)
		}
	}
	flusher.Flush()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case n, ok := <-l.ch:
			if !ok {
				return nil
			}
			if n.change.ID <= upper {
				continue
			}
			sendEvent(w, n.change.ID, n.prefix)
			flusher.Flush()
		case <-ticker.C:
			io.WriteString(w, ": keep-alive\n\n")
			flusher.Flush()
		case <-r.Context().Done():
			return nil
		}
	}
}
func sendEvent(w io.Writer, id int64, prefix string) {
	fmt.Fprintf(w, "id: %d\nevent: invalidate\ndata: %s\n\n", id, prefix)
}
func matchingPrefix(prefixes []string, key string) (string, bool) {
	matches := []string{}
	for _, p := range prefixes {
		if strings.HasPrefix(key, p) {
			matches = append(matches, p)
		}
	}
	if len(matches) == 0 {
		return "", false
	}
	sort.Slice(matches, func(i, j int) bool { return len(matches[i]) < len(matches[j]) })
	return matches[0], true
}

func (a *App) admin(w http.ResponseWriter, r *http.Request) error {
	relative := strings.TrimPrefix(r.URL.Path, "/admin/")
	decoded, err := urlPathUnescape(relative)
	if err != nil {
		return core.Fail(400, "Invalid admin asset path")
	}
	relative = decoded
	if relative == "" || relative == "key" || strings.HasPrefix(relative, "key/") || relative == "prefix" || strings.HasPrefix(relative, "prefix/") {
		relative = "index.html"
	}
	if strings.Contains(relative, "\\") || strings.Contains(relative, "..") || filepath.IsAbs(relative) {
		return core.Fail(404, "Admin asset not found")
	}
	data, err := os.ReadFile(filepath.Join(a.adminRoot, filepath.FromSlash(relative)))
	if err != nil {
		if os.IsNotExist(err) && relative != "index.html" && !strings.HasPrefix(relative, "assets/") {
			data, err = os.ReadFile(filepath.Join(a.adminRoot, "index.html"))
			relative = "index.html"
		}
		if err != nil {
			return core.Fail(404, "Admin asset not found")
		}
	}
	ext := filepath.Ext(relative)
	content := mime.TypeByExtension(ext)
	if ext == ".js" {
		content = "text/javascript; charset=utf-8"
	}
	if ext == ".html" {
		content = "text/html; charset=utf-8"
	}
	w.Header().Set("Content-Type", content)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if relative == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	if r.Method != "HEAD" {
		_, _ = w.Write(data)
	}
	return nil
}
func urlPathUnescape(s string) (string, error) { // QueryUnescape incorrectly turns '+' into spaces.
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			out.WriteByte(s[i])
			continue
		}
		if i+2 >= len(s) {
			return "", errors.New("escape")
		}
		n, e := strconv.ParseUint(s[i+1:i+3], 16, 8)
		if e != nil {
			return "", e
		}
		out.WriteByte(byte(n))
		i += 2
	}
	return out.String(), nil
}

func readObject(r *http.Request, dst any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 10<<20))
	if e := decoder.Decode(dst); e != nil {
		return core.Fail(400, "Body must be a JSON object")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return core.Fail(400, "Body must be a JSON object")
	}
	return nil
}
func parseETag(s string) string { s = strings.TrimPrefix(s, "W/"); return strings.Trim(s, "\"") }
func quote(s string) string     { return `"` + s + `"` }
func writeJSON(w http.ResponseWriter, status int, v any) {
	data, _ := json.Marshal(v)
	writeRawJSON(w, status, data)
}
func writeRawJSON(w http.ResponseWriter, status int, data []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(data)
}
