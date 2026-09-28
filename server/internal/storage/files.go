package storage

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"synckv/server/internal/core"
)

// Files persists the complete small personal-workload state as one atomically
// replaced JSON file. The path may name either a directory or a .json file.
type Files struct {
	mu    sync.RWMutex
	path  string
	state core.State
}

func NewFiles(path string) (*Files, error) {
	if filepath.Ext(path) == "" {
		path = filepath.Join(path, "synckv.json")
	}
	f := &Files{path: path, state: core.EmptyState()}
	data, err := os.ReadFile(path)
	if err == nil {
		if err = json.Unmarshal(data, &f.state); err != nil {
			return nil, err
		}
		f.state = core.Normalize(f.state)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return f, nil
}
func (f *Files) Snapshot(context.Context) (core.State, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.state, nil
}
func (f *Files) Update(_ context.Context, transition func(core.State) (core.State, core.Result, error)) (core.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	next, result, err := transition(f.state)
	if err != nil {
		return result, err
	}
	data, err := json.Marshal(next)
	if err != nil {
		return result, err
	}
	if err = os.MkdirAll(filepath.Dir(f.path), 0o755); err != nil {
		return result, err
	}
	temporary := f.path + ".tmp"
	if err = os.WriteFile(temporary, data, 0o600); err != nil {
		return result, err
	}
	if err = os.Rename(temporary, f.path); err != nil {
		_ = os.Remove(temporary)
		return result, err
	}
	f.state = next
	return result, nil
}
func (f *Files) blobPath(hash string) string { return f.path + ".blobs/" + hash[:2] + "/" + hash }
func (f *Files) HasBlob(_ context.Context, hash string) (bool, error) {
	_, err := os.Stat(f.blobPath(hash))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
func (f *Files) PutBlob(_ context.Context, hash string, data []byte) error {
	path := f.blobPath(hash)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
func (f *Files) GetBlob(_ context.Context, hash string) ([]byte, error) {
	return os.ReadFile(f.blobPath(hash))
}
func (f *Files) Close() error { return nil }
