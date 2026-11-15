package push

// The push wire's Go half: every fixture in contract/push decodes here with no unknown field and
// encodes back to the same JSON. The gateway's side, in TypeScript, takes
// the same files through the store's checks, so a field one side adds, renames or drops alone fails
// one of the two.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPushWireFixturesRoundTrip(t *testing.T) {
	// A page's rows typed as SendBody's are by the job's kind; its other fields are SendBody's.
	type sendPreview struct {
		Page  int64        `json:"page"`
		Rows  []PreviewRow `json:"rows"`
		Last  *string      `json:"last,omitempty"`
		Table int          `json:"table,omitempty"`
	}
	type sendCompare struct {
		Page  int64        `json:"page"`
		Rows  []CompareRow `json:"rows"`
		Last  *string      `json:"last,omitempty"`
		Table int          `json:"table,omitempty"`
	}
	type sendPush struct {
		Page  int64        `json:"page"`
		Rows  []WrittenRow `json:"rows"`
		Last  *string      `json:"last,omitempty"`
		Table int          `json:"table,omitempty"`
	}
	type sendUndo struct {
		Page  int64       `json:"page"`
		Rows  []UndoneRow `json:"rows"`
		Last  *string     `json:"last,omitempty"`
		Table int         `json:"table,omitempty"`
	}
	type readWrite struct {
		Rows []WriteRow `json:"rows"`
		Next *string    `json:"next"`
	}
	type readUndo struct {
		Rows []UndoRow `json:"rows"`
		Next *string   `json:"next"`
	}
	fixtures := map[string]any{
		"state.json":              &State{},
		"state-several.json":      &State{},
		"begin-body.json":         &BeginBody{},
		"begin-again-body.json":   &BeginAgainBody{},
		"begin-answer.json":       &BeginAnswer{},
		"read-body.json":          &ReadBody{},
		"read-body-puts.json":     &ReadBody{},
		"read-body-undo.json":     &ReadBody{},
		"read-answer-write.json":  &readWrite{},
		"read-answer-undo.json":   &readUndo{},
		"send-body-preview.json":  &sendPreview{},
		"send-body-compare.json":  &sendCompare{},
		"send-body-push.json":     &sendPush{},
		"send-body-undo.json":     &sendUndo{},
		"send-answer.json":        &SendAnswer{},
		"end-body.json":           &EndBody{},
		"end-body-committed.json": &EndBody{},
		"end-body-rehearsal.json": &EndBody{},
		"end-body-links.json":     &EndBody{},
		"end-answer.json":         &EndAnswer{},
	}
	files, err := filepath.Glob("../../contract/push/*.json")
	if err != nil || len(files) != len(fixtures) {
		t.Fatalf("the push fixtures: %v %v (each needs a type here)", files, err)
	}
	for file, into := range fixtures {
		t.Run(file, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("../../contract/push", file))
			if err != nil {
				t.Fatal(err)
			}
			dec := json.NewDecoder(bytes.NewReader(data))
			dec.DisallowUnknownFields()
			if err := dec.Decode(into); err != nil {
				t.Fatalf("decode: %v", err)
			}
			again, err := json.Marshal(into)
			if err != nil {
				t.Fatal(err)
			}
			var want, got any
			_ = json.Unmarshal(data, &want)
			_ = json.Unmarshal(again, &got)
			if !reflect.DeepEqual(want, got) {
				t.Fatalf("round trip changed it:\nwant %v\ngot  %v", want, got)
			}
		})
	}
}
