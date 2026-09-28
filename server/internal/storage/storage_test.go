package storage

import (
	"context"
	"encoding/json"
	"path/filepath"
	"synckv/server/internal/core"
	"synckv/server/internal/port"
	"testing"
)

func TestAdaptersShareTheSameContract(t *testing.T) {
	tests := []struct {
		name string
		open func() (port.Storage, error)
	}{
		{"memory", func() (port.Storage, error) { return NewMemory(), nil }},
		{"files", func() (port.Storage, error) { return NewFiles(filepath.Join(t.TempDir(), "state.json")) }},
		{"sqlite", func() (port.Storage, error) { return NewSQLite(filepath.Join(t.TempDir(), "state.sqlite")) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, err := test.open()
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			_, err = store.Update(context.Background(), func(s core.State) (core.State, core.Result, error) {
				return core.Apply(s, core.Command{ID: "id", Fingerprint: "f", Operations: []core.Operation{{Type: "set", Key: "key", Value: json.RawMessage(`true`), RequireAbsent: true}}})
			})
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := store.Snapshot(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			value, err := core.Get(snapshot, "key")
			if err != nil || string(value.JSON) != "true" {
				t.Fatalf("get: %s %v", value.JSON, err)
			}
		})
	}
}

func TestPersistentAdaptersReopen(t *testing.T) {
	for _, kind := range []string{"files", "sqlite"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state")
			open := func() (port.Storage, error) {
				if kind == "files" {
					return NewFiles(path + ".json")
				}
				return NewSQLite(path + ".sqlite")
			}
			first, err := open()
			if err != nil {
				t.Fatal(err)
			}
			_, err = first.Update(context.Background(), func(s core.State) (core.State, core.Result, error) {
				return core.Apply(s, core.Command{ID: "persist", Fingerprint: "p", Operations: []core.Operation{{Type: "set", Key: "persistent", Value: json.RawMessage(`1`), RequireAbsent: true}}})
			})
			if err != nil {
				t.Fatal(err)
			}
			first.Close()
			second, err := open()
			if err != nil {
				t.Fatal(err)
			}
			defer second.Close()
			s, _ := second.Snapshot(context.Background())
			if _, err = core.Get(s, "persistent"); err != nil {
				t.Fatal(err)
			}
		})
	}
}
