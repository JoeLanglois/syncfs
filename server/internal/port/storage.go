// Package port defines the driven boundary used by the application.
package port

import (
	"context"
	"synckv/server/internal/core"
)

type Storage interface {
	Snapshot(context.Context) (core.State, error)
	Update(context.Context, func(core.State) (core.State, core.Result, error)) (core.Result, error)
	HasBlob(context.Context, string) (bool, error)
	PutBlob(context.Context, string, []byte) error
	GetBlob(context.Context, string) ([]byte, error)
	Close() error
}
