package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"sync"
	"synckv/server/internal/core"
)

type SQLite struct {
	mu sync.RWMutex
	db *sql.DB
}

func NewSQLite(filename string) (*SQLite, error) {
	if filename != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", filename)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &SQLite{db: db}
	_, err = db.Exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, etag TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv_mutations (idempotency_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, origin_client_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blob_metadata (key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT NOT NULL, filename TEXT, etag TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blob_content (hash TEXT PRIMARY KEY, content BLOB NOT NULL, created_at TEXT NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func load(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}) (core.State, error) {
	s := core.EmptyState()
	rows, err := q.QueryContext(ctx, `SELECT key,value,etag FROM kv`)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var k, v, e string
		if err = rows.Scan(&k, &v, &e); err != nil {
			rows.Close()
			return s, err
		}
		s.Values[k] = core.Value{Kind: "json", JSON: json.RawMessage(v), ETag: e}
	}
	if err = rows.Close(); err != nil {
		return s, err
	}
	rows, err = q.QueryContext(ctx, `SELECT key,sha256,size,content_type,COALESCE(filename,''),etag FROM blob_metadata`)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var k, e string
		var b core.BlobManifest
		if err = rows.Scan(&k, &b.SHA256, &b.Size, &b.ContentType, &b.Filename, &e); err != nil {
			rows.Close()
			return s, err
		}
		s.Values[k] = core.Value{Kind: "blob", Blob: &b, ETag: e}
	}
	if err = rows.Close(); err != nil {
		return s, err
	}
	rows, err = q.QueryContext(ctx, `SELECT idempotency_key,fingerprint,status,response FROM kv_mutations`)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var k, f, b string
		var status int
		if err = rows.Scan(&k, &f, &status, &b); err != nil {
			rows.Close()
			return s, err
		}
		s.Responses[k] = core.StoredResponse{Fingerprint: f, Status: status, Body: json.RawMessage(b)}
	}
	if err = rows.Close(); err != nil {
		return s, err
	}
	rows, err = q.QueryContext(ctx, `SELECT id,key,COALESCE(origin_client_id,'') FROM kv_changes ORDER BY id`)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var c core.Change
		if err = rows.Scan(&c.ID, &c.Key, &c.Origin); err != nil {
			rows.Close()
			return s, err
		}
		s.Changes = append(s.Changes, c)
		if c.ID >= s.NextID {
			s.NextID = c.ID + 1
		}
	}
	return s, rows.Close()
}
func (s *SQLite) Snapshot(ctx context.Context) (core.State, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return load(ctx, s.db)
}
func (s *SQLite) Update(ctx context.Context, transition func(core.State) (core.State, core.Result, error)) (core.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return core.Result{}, err
	}
	current, err := load(ctx, tx)
	if err != nil {
		tx.Rollback()
		return core.Result{}, err
	}
	next, result, err := transition(current)
	if err != nil {
		tx.Rollback()
		return result, err
	}
	if result.Replay {
		if err = tx.Commit(); err != nil {
			return result, err
		}
		return result, nil
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM kv; DELETE FROM blob_metadata; DELETE FROM kv_mutations; DELETE FROM kv_changes;`); err != nil {
		tx.Rollback()
		return result, err
	}
	for k, v := range next.Values {
		if v.Kind == "blob" && v.Blob != nil {
			if _, err = tx.ExecContext(ctx, `INSERT INTO blob_metadata(key,sha256,size,content_type,filename,etag) VALUES(?,?,?,?,?,?)`, k, v.Blob.SHA256, v.Blob.Size, v.Blob.ContentType, v.Blob.Filename, v.ETag); err != nil {
				tx.Rollback()
				return result, err
			}
		} else if _, err = tx.ExecContext(ctx, `INSERT INTO kv(key,value,etag,updated_at) VALUES(?,?,?,datetime('now'))`, k, string(v.JSON), v.ETag); err != nil {
			tx.Rollback()
			return result, err
		}
	}
	for k, v := range next.Responses {
		if _, err = tx.ExecContext(ctx, `INSERT INTO kv_mutations(idempotency_key,fingerprint,status,response,created_at) VALUES(?,?,?,?,datetime('now'))`, k, v.Fingerprint, v.Status, string(v.Body)); err != nil {
			tx.Rollback()
			return result, err
		}
	}
	for _, c := range next.Changes {
		var origin any
		if c.Origin != "" {
			origin = c.Origin
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO kv_changes(id,key,origin_client_id,created_at) VALUES(?,?,?,datetime('now'))`, c.ID, c.Key, origin); err != nil {
			tx.Rollback()
			return result, err
		}
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}
func (s *SQLite) HasBlob(ctx context.Context, hash string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM blob_content WHERE hash=?`, hash).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}
func (s *SQLite) PutBlob(ctx context.Context, hash string, data []byte) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO blob_content(hash,content,created_at) VALUES(?,?,datetime('now')) ON CONFLICT(hash) DO NOTHING`, hash, data)
	return err
}
func (s *SQLite) GetBlob(ctx context.Context, hash string) ([]byte, error) {
	var data []byte
	err := s.db.QueryRowContext(ctx, `SELECT content FROM blob_content WHERE hash=?`, hash).Scan(&data)
	return data, err
}
func (s *SQLite) Close() error { return s.db.Close() }
