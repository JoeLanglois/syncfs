package storage

import (
	"context"
	"sync"
	"synckv/server/internal/core"
)

// Memory is the simplest adapter and is useful for tests and ephemeral servers.
type Memory struct {
	mu    sync.RWMutex
	state core.State
}

func NewMemory() *Memory { return &Memory{state: core.EmptyState()} }
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
func (m *Memory) Close() error { return nil }
