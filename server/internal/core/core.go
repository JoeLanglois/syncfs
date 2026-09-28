// Package core contains the sync domain as side-effect-free state transitions.
package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

type Value struct {
	JSON json.RawMessage `json:"value"`
	ETag string          `json:"etag"`
}

type StoredResponse struct {
	Fingerprint string          `json:"fingerprint"`
	Status      int             `json:"status"`
	Body        json.RawMessage `json:"body"`
}

type Change struct {
	ID     int64  `json:"id"`
	Key    string `json:"key"`
	Origin string `json:"origin,omitempty"`
}

type State struct {
	Values    map[string]Value          `json:"values"`
	Responses map[string]StoredResponse `json:"responses"`
	Changes   []Change                  `json:"changes"`
	NextID    int64                     `json:"nextId"`
}

func EmptyState() State {
	return State{Values: map[string]Value{}, Responses: map[string]StoredResponse{}, NextID: 1}
}

// Normalize makes states loaded from older or hand-written files safe to use.
func Normalize(s State) State {
	if s.Values == nil {
		s.Values = map[string]Value{}
	}
	if s.Responses == nil {
		s.Responses = map[string]StoredResponse{}
	}
	if s.NextID < 1 {
		s.NextID = 1
		for _, c := range s.Changes {
			if c.ID >= s.NextID {
				s.NextID = c.ID + 1
			}
		}
	}
	return s
}

type Operation struct {
	Type          string          `json:"type"`
	Key           string          `json:"key"`
	Value         json.RawMessage `json:"value,omitempty"`
	BaseETag      string          `json:"baseEtag,omitempty"`
	RequireAbsent bool            `json:"-"`
}

type Command struct {
	ID             string
	Fingerprint    string
	Operations     []Operation
	Origin         string
	SingleResponse bool
}

type Result struct {
	Status int
	Body   json.RawMessage
	Replay bool
}

type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }
func Fail(status int, format string, args ...any) *Error {
	return &Error{Status: status, Message: fmt.Sprintf(format, args...)}
}

func Hash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func CompactJSON(data []byte) (json.RawMessage, error) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		return nil, err
	}
	return compact.Bytes(), nil
}

// Apply validates the complete command before producing a new state. Its input is
// never modified, so adapters can commit the returned state atomically.
func Apply(input State, command Command) (State, Result, error) {
	input = Normalize(input)
	if prior, ok := input.Responses[command.ID]; ok {
		if prior.Fingerprint != command.Fingerprint {
			return input, Result{}, Fail(409, "Idempotency key reused")
		}
		return input, Result{Status: prior.Status, Body: cloneBytes(prior.Body), Replay: true}, nil
	}

	etags := make(map[string]*string, len(command.Operations))
	serialized := make(map[string]json.RawMessage, len(command.Operations))
	for _, op := range command.Operations {
		current, exists := input.Values[op.Key]
		if op.BaseETag == "" {
			if op.RequireAbsent && exists {
				return input, Result{}, Fail(412, "Key already exists: %s", op.Key)
			}
		} else if !exists {
			return input, Result{}, Fail(412, "Key no longer exists: %s", op.Key)
		} else if current.ETag != op.BaseETag {
			return input, Result{}, Fail(412, "ETag conflict: %s", op.Key)
		}
		if op.Type == "delete" {
			if !exists {
				return input, Result{}, Fail(404, "Key not found: %s", op.Key)
			}
			etags[op.Key] = nil
		} else if op.Type == "set" {
			compact, err := CompactJSON(op.Value)
			if err != nil {
				return input, Result{}, Fail(400, "Value is not JSON serializable")
			}
			serialized[op.Key] = compact
			h := Hash(compact)
			etags[op.Key] = &h
		} else {
			return input, Result{}, Fail(400, "Unknown transaction operation")
		}
	}

	next := cloneState(input)
	for _, op := range command.Operations {
		if op.Type == "delete" {
			delete(next.Values, op.Key)
		} else {
			next.Values[op.Key] = Value{JSON: cloneBytes(serialized[op.Key]), ETag: *etags[op.Key]}
		}
		next.Changes = append(next.Changes, Change{ID: next.NextID, Key: op.Key, Origin: command.Origin})
		next.NextID++
	}
	body, _ := json.Marshal(struct {
		ETags map[string]*string `json:"etags"`
	}{etags})
	if command.SingleResponse && len(command.Operations) == 1 {
		if command.Operations[0].Type == "delete" {
			body = []byte(`{}`)
		} else {
			body, _ = json.Marshal(struct {
				ETag string `json:"etag"`
			}{*etags[command.Operations[0].Key]})
		}
	}
	result := Result{Status: 200, Body: body}
	next.Responses[command.ID] = StoredResponse{Fingerprint: command.Fingerprint, Status: result.Status, Body: cloneBytes(body)}
	return next, result, nil
}

func Get(s State, key string) (Value, error) {
	value, ok := Normalize(s).Values[key]
	if !ok {
		return Value{}, Fail(404, "Key not found: %s", key)
	}
	value.JSON = cloneBytes(value.JSON)
	return value, nil
}

type Entry struct {
	Key  string `json:"key"`
	ETag string `json:"etag"`
}

func List(s State, prefix string) ([]Entry, string) {
	entries := []Entry{}
	for key, value := range Normalize(s).Values {
		if strings.HasPrefix(key, prefix) {
			entries = append(entries, Entry{key, value.ETag})
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Key < entries[j].Key })
	encoded, _ := json.Marshal(entries)
	return entries, Hash(encoded)
}

func ChangesAfter(s State, id int64) []Change {
	result := []Change{}
	for _, c := range s.Changes {
		if c.ID > id {
			result = append(result, c)
			if len(result) == 1000 {
				break
			}
		}
	}
	return result
}

func LatestChangeID(s State) int64 {
	if len(s.Changes) == 0 {
		return 0
	}
	return s.Changes[len(s.Changes)-1].ID
}

func cloneBytes[T ~[]byte](b T) T { return append(T(nil), b...) }
func cloneState(s State) State {
	n := EmptyState()
	n.NextID = s.NextID
	for k, v := range s.Values {
		v.JSON = cloneBytes(v.JSON)
		n.Values[k] = v
	}
	for k, v := range s.Responses {
		v.Body = cloneBytes(v.Body)
		n.Responses[k] = v
	}
	n.Changes = append([]Change(nil), s.Changes...)
	return n
}
