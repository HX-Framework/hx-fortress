package pull

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"hx-fortress/data-runner/internal/engine"
)

// The store's side of a pull, as the store's gateway serves it. Every call carries the job's key;
// the store keeps only the key it gave last, so a newer data job's key makes this one's refused.
// contract/pull/ holds one example of each body and answer, which the gateway's side reads too.

// Source is a table of the database, as its catalog names it.
type Source struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
}

func (s Source) String() string { return s.Schema + "." + s.Name }

// TableState is where one table of the job stands.
type TableState struct {
	Source Source  `json:"source"`
	Into   string  `json:"into"`
	Mode   *string `json:"mode"`
	Page   int64   `json:"page"`
	Ended  bool    `json:"ended"`
}

// Limits are what a page may hold.
type Limits struct {
	PageRows  int `json:"pageRows"`
	PageBytes int `json:"pageBytes"`
	HashRows  int `json:"hashRows"`
	RowBytes  int `json:"rowBytes"`
	Removed   int `json:"removed"`
}

// State is where the job stands.
type State struct {
	// State is waiting, taking, finishing, done or failed.
	State  string       `json:"state"`
	Error  *string      `json:"error"`
	Tables []TableState `json:"tables"`
	Limits Limits       `json:"limits"`
}

// BeginBody says a table's columns and key, as read from the database just now.
type BeginBody struct {
	Table   int             `json:"table"`
	Columns []engine.Column `json:"columns"`
	Key     []string        `json:"key"`
}

// BeginAnswer says how the store writes the table, and the last page it took for it.
type BeginAnswer struct {
	Mode string `json:"mode"`
	Page int64  `json:"page"`
}

// HashesBody asks for what the store holds of a table, by _key, after After.
type HashesBody struct {
	Table int     `json:"table"`
	After *string `json:"after"`
	Limit int     `json:"limit,omitempty"`
}

// HashesAnswer is `[_key, _hash]` pairs in _key order; Next is nil after the last.
type HashesAnswer struct {
	Hashes [][2]string `json:"hashes"`
	Next   *string     `json:"next"`
}

// PageAnswer says whether the store took the page, and what it did.
type PageAnswer struct {
	Page    int64 `json:"page"`
	Taken   bool  `json:"taken"`
	Added   int64 `json:"added"`
	Changed int64 `json:"changed"`
	Removed int64 `json:"removed"`
}

// EndBody says every row of a table was read and every page that differs was sent.
type EndBody struct {
	Table int   `json:"table"`
	Read  int64 `json:"read"`
	Cut   int64 `json:"cut"`
}

// EndAnswer says whether every table has ended, so the store is making them visible.
type EndAnswer struct {
	Finishing bool `json:"finishing"`
}

// FailBody says why the runner could not go on.
type FailBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Store is the store's side of a pull.
type Store interface {
	State(ctx context.Context) (State, error)
	Begin(ctx context.Context, body BeginBody) (BeginAnswer, error)
	Hashes(ctx context.Context, body HashesBody) (HashesAnswer, error)
	// Page sends one page: rowsJSON is the rows' JSON array elements, joined by commas, as sent.
	Page(ctx context.Context, table int, page int64, rowsJSON []byte, removed []string) (PageAnswer, error)
	End(ctx context.Context, body EndBody) (EndAnswer, error)
	Fail(ctx context.Context, body FailBody) error
}

// StoreError is the store's refusal, with its code and its words.
type StoreError struct {
	Status  int
	Code    string
	Message string
}

func (e *StoreError) Error() string {
	return fmt.Sprintf("the store refused the call (%d %s): %s", e.Status, e.Code, e.Message)
}

// KeyRefused says the store no longer takes this job's key: a newer data job took the pull over.
func KeyRefused(err error) bool {
	var refused *StoreError
	return errors.As(err, &refused) && refused.Code == "job_key_refused"
}

// AtWriteLimit is the store's words when it refused a page at its daily write limit, or "".
func AtWriteLimit(err error) string {
	var refused *StoreError
	if errors.As(err, &refused) && refused.Code == "write_limit_reached" {
		return refused.Message
	}
	return ""
}

// HTTPStore is the store's gateway over HTTP.
type HTTPStore struct {
	base   string
	key    string
	client *http.Client
	sleep  func(ctx context.Context, d time.Duration) error
}

const (
	// storeCallTimeout bounds one call; the store's page work is seconds at most.
	storeCallTimeout = 90 * time.Second
	// storeTries is how many times a call is made before its error is the answer.
	storeTries = 6
)

// NewHTTPStore talks to the gateway at gatewayURL for one store's one pull, with its key.
func NewHTTPStore(gatewayURL, storeID, jobID, key string, sleep func(ctx context.Context, d time.Duration) error) *HTTPStore {
	return NewJobCaller(gatewayURL, storeID, jobID, key, "pull", sleep)
}

// NewJobCaller talks to the gateway for one store's one job, with its key, on the job's routes under
// `route` (a pull's `pull`; a push's or a compare's `rows`).
func NewJobCaller(gatewayURL, storeID, jobID, key, route string, sleep func(ctx context.Context, d time.Duration) error) *HTTPStore {
	base := strings.TrimRight(gatewayURL, "/") + "/v1/stores/" + url.PathEscape(storeID) + "/jobs/" + url.PathEscape(jobID) + "/" + route
	return &HTTPStore{base: base, key: key, client: &http.Client{Timeout: storeCallTimeout, CheckRedirect: noRedirects}, sleep: sleep}
}

// noRedirects keeps a redirect as the gateway's answer. A page holds rows, and every call carries
// the job's key: neither is sent on to an address the job did not name, whoever asks for that.
func noRedirects(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// Get makes a GET call of the job's routes, tried again on the network's or the store's passing
// trouble, and decodes the answer into out.
func (s *HTTPStore) Get(ctx context.Context, path string, out any) error {
	return s.call(ctx, http.MethodGet, path, nil, out)
}

// Post makes a POST call of the job's routes with body as JSON, as Get does.
func (s *HTTPStore) Post(ctx context.Context, path string, body, out any) error {
	return s.post(ctx, path, body, out)
}

func (s *HTTPStore) call(ctx context.Context, method, path string, body []byte, out any) error {
	var last error
	wait := 500 * time.Millisecond
	for try := 1; try <= storeTries; try++ {
		retry, err := s.once(ctx, method, path, body, out)
		if err == nil {
			return nil
		}
		if !retry || ctx.Err() != nil {
			return err
		}
		last = err
		if try == storeTries {
			break
		}
		if err := s.sleep(ctx, wait); err != nil {
			return last
		}
		wait *= 2
	}
	return last
}

// once makes the call once, and says whether a failure may be tried again: the network, a timeout,
// or the store's passing trouble (5xx). A refusal is the answer.
func (s *HTTPStore) once(ctx context.Context, method, path string, body []byte, out any) (retry bool, err error) {
	req, err := http.NewRequestWithContext(ctx, method, s.base+path, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+s.key)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.client.Do(req)
	if err != nil {
		// http.Client's errors quote the URL, which holds nothing secret.
		return true, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return true, err
	}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		if out == nil {
			return false, nil
		}
		if err := json.Unmarshal(raw, out); err != nil {
			return false, fmt.Errorf("the store answered something this runner cannot read: %w", err)
		}
		return false, nil
	}
	if res.StatusCode >= 300 && res.StatusCode < 400 {
		return false, &StoreError{Status: res.StatusCode, Code: "redirect", Message: "the store's gateway sent the call on to another address, and a data job follows no redirect"}
	}
	var refusal struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	_ = json.Unmarshal(raw, &refusal)
	if refusal.Error == "" {
		refusal.Error = fmt.Sprintf("HTTP %d", res.StatusCode)
	}
	return res.StatusCode >= 500, &StoreError{Status: res.StatusCode, Code: refusal.Code, Message: refusal.Error}
}

func (s *HTTPStore) post(ctx context.Context, path string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return s.call(ctx, http.MethodPost, path, raw, out)
}

// State is where the job stands.
func (s *HTTPStore) State(ctx context.Context) (State, error) {
	var out State
	err := s.call(ctx, http.MethodGet, "", nil, &out)
	return out, err
}

// Begin says a table's columns and key, and answers how the store writes it.
func (s *HTTPStore) Begin(ctx context.Context, body BeginBody) (BeginAnswer, error) {
	var out BeginAnswer
	err := s.post(ctx, "/begin", body, &out)
	return out, err
}

// Hashes reads what the store holds of a table.
func (s *HTTPStore) Hashes(ctx context.Context, body HashesBody) (HashesAnswer, error) {
	var out HashesAnswer
	err := s.post(ctx, "/hashes", body, &out)
	return out, err
}

// Page sends one page. A page sent again answers as taken before.
func (s *HTTPStore) Page(ctx context.Context, table int, page int64, rowsJSON []byte, removed []string) (PageAnswer, error) {
	var out PageAnswer
	body, err := pageJSON(table, page, rowsJSON, removed)
	if err != nil {
		return out, err
	}
	err = s.call(ctx, http.MethodPost, "/page", body, &out)
	return out, err
}

// pageJSON is a page's body, with the rows already JSON.
func pageJSON(table int, page int64, rowsJSON []byte, removed []string) ([]byte, error) {
	if removed == nil {
		removed = []string{}
	}
	keys, err := json.Marshal(removed)
	if err != nil {
		return nil, err
	}
	var b bytes.Buffer
	b.Grow(len(rowsJSON) + len(keys) + 64)
	fmt.Fprintf(&b, `{"table":%d,"page":%d,"rows":[`, table, page)
	b.Write(rowsJSON)
	b.WriteString(`],"removed":`)
	b.Write(keys)
	b.WriteByte('}')
	return b.Bytes(), nil
}

// End says every row of a table was read.
func (s *HTTPStore) End(ctx context.Context, body EndBody) (EndAnswer, error) {
	var out EndAnswer
	err := s.post(ctx, "/end", body, &out)
	return out, err
}

// Fail says why the runner could not go on.
func (s *HTTPStore) Fail(ctx context.Context, body FailBody) error {
	return s.post(ctx, "/fail", body, nil)
}
