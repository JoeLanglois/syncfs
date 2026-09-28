package storage

import (
	"context"
	"os"
	"sync"
	"synckv/server/internal/core"
)

// Memory is the simplest adapter and is useful for tests and ephemeral servers.
type Memory struct {
	mu    sync.RWMutex
	state core.State
	blobs map[string][]byte
}

func NewMemory() *Memory { return &Memory{state: core.EmptyState(), blobs: map[string][]byte{}} }
func (m *Memory) Snapshot(context.Context) (core.State, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	// Core transitions clone before mutation, so sharing this snapshot is safe.
	return m.state, nil
}
func (m *Memory) Update(_ context.Context, f func(core.State) (core.State, core.Result, error)) (core.Result, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	next, result, err := f(m.state)
	if err == nil {
		m.state = next
	}
	return result, err
}
func (m *Memory) HasBlob(_ context.Context, hash string) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.blobs[hash]
	return ok, nil
}
func (m *Memory) PutBlob(_ context.Context, hash string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.blobs[hash] = append([]byte(nil), data...)
	return nil
}
func (m *Memory) GetBlob(_ context.Context, hash string) ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	data, ok := m.blobs[hash]
	if !ok {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), data...), nil
}
func (m *Memory) Close() error { return nil }
