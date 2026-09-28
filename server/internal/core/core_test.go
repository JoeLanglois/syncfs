package core

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestApplyIsPureAtomicAndIdempotent(t *testing.T) {
	original := EmptyState()
	created, result, err := Apply(original, Command{ID: "one", Fingerprint: "create", Operations: []Operation{{Type: "set", Key: "a", Value: json.RawMessage(`{ "n": 1 }`), RequireAbsent: true}}})
	if err != nil || result.Status != 200 {
		t.Fatalf("create: %v %#v", err, result)
	}
	if len(original.Values) != 0 {
		t.Fatal("Apply mutated its input")
	}
	if string(created.Values["a"].JSON) != `{"n":1}` {
		t.Fatalf("JSON was not compacted: %s", created.Values["a"].JSON)
	}
	etag := created.Values["a"].ETag
	_, _, err = Apply(created, Command{ID: "bad", Fingerprint: "bad", Operations: []Operation{{Type: "set", Key: "a", Value: json.RawMessage(`2`), BaseETag: "stale"}, {Type: "set", Key: "b", Value: json.RawMessage(`3`), RequireAbsent: true}}})
	if status(err) != 412 || len(created.Values) != 1 {
		t.Fatalf("transaction was not atomic: %v", err)
	}
	updated, _, err := Apply(created, Command{ID: "two", Fingerprint: "update", Operations: []Operation{{Type: "set", Key: "a", Value: json.RawMessage(`2`), BaseETag: etag}}})
	if err != nil {
		t.Fatal(err)
	}
	replayed, replay, err := Apply(updated, Command{ID: "two", Fingerprint: "update"})
	if err != nil || !replay.Replay || replayed.Values["a"].ETag != updated.Values["a"].ETag {
		t.Fatal("idempotent replay failed")
	}
}

func TestBlobManifestIsMetadataOnlyAndListed(t *testing.T) {
	s := EmptyState()
	manifest := &BlobManifest{SHA256: strings.Repeat("a", 64), Size: 4, ContentType: "text/plain", Filename: "a.txt"}
	next, _, err := Apply(s, Command{ID: "blob", Fingerprint: "blob", Operations: []Operation{{Type: "setBlob", Key: "files/a", Blob: manifest, RequireAbsent: true}}})
	if err != nil {
		t.Fatal(err)
	}
	value := next.Values["files/a"]
	if value.Kind != "blob" || value.Blob.SHA256 != manifest.SHA256 || len(value.JSON) != 0 {
		t.Fatalf("bad blob value: %#v", value)
	}
	entries, _ := List(next, "files/")
	if len(entries) != 1 || entries[0].Kind != "blob" || entries[0].Blob.Size != 4 {
		t.Fatalf("bad listing: %#v", entries)
	}
}

func TestListIsSortedAndHasStableHash(t *testing.T) {
	s := EmptyState()
	s.Values["p/b"] = Value{ETag: "b"}
	s.Values["p/a"] = Value{ETag: "a"}
	s.Values["x"] = Value{ETag: "x"}
	entries, first := List(s, "p/")
	_, second := List(s, "p/")
	if len(entries) != 2 || entries[0].Key != "p/a" || first != second {
		t.Fatalf("unstable listing: %#v", entries)
	}
}
func status(err error) int {
	if e, ok := err.(*Error); ok {
		return e.Status
	}
	return 0
}
