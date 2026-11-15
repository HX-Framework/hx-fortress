package pull

import (
	"encoding/json"
	"os"
	"testing"
)

// The vectors are the answers of the store's own `rowHash`, in TypeScript, so the Go port and that
// function cannot drift apart.
func TestRowHashMatchesTheStoreReaders(t *testing.T) {
	data, err := os.ReadFile("../../contract/vectors/row-hash.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Values []*string `json:"values"`
			Hash   string    `json:"hash"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) < 10 {
		t.Fatalf("only %d vectors", len(file.Cases))
	}
	for _, c := range file.Cases {
		if got := RowHash(c.Values); got != c.Hash {
			t.Errorf("RowHash(%v) = %s, want %s", c.Values, got, c.Hash)
		}
	}
}
