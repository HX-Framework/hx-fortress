package pull

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// A job's rows and its key go to its store's gateway and to no other address. When the gateway, or
// anything on the way to it, answers a call with a redirect, the call is refused: Go's own client
// would send a page's rows on to wherever the answer pointed.
func TestAStoreCallFollowsNoRedirect(t *testing.T) {
	var elsewhereHeard atomic.Int32
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		elsewhereHeard.Add(1)
		_, _ = w.Write([]byte(`{"state":"taking","tables":[],"limits":{}}`))
	}))
	defer elsewhere.Close()
	for _, status := range []int{http.StatusFound, http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		var gatewayHeard atomic.Int32
		gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gatewayHeard.Add(1)
			http.Redirect(w, r, elsewhere.URL+r.URL.Path, status)
		}))
		noSleep := func(context.Context, time.Duration) error { return nil }
		store := NewHTTPStore(gateway.URL, "sto_1", "job_1", "k1.the-store-key", noSleep)

		_, err := store.Page(context.Background(), 0, 1, []byte(`["BP-2026-0412","18 Mill Road"]`), nil)
		var refused *StoreError
		if !errors.As(err, &refused) || refused.Status != status || refused.Code != "redirect" {
			t.Fatalf("a page answered with %d: %v", status, err)
		}
		if _, err := store.State(context.Background()); !errors.As(err, &refused) || refused.Code != "redirect" {
			t.Fatalf("a read answered with %d: %v", status, err)
		}
		// Each call was made once: a redirect is an answer, not trouble to try again.
		if n := gatewayHeard.Load(); n != 2 {
			t.Fatalf("the gateway heard %d calls for two", n)
		}
		gateway.Close()
	}
	if n := elsewhereHeard.Load(); n != 0 {
		t.Fatalf("%d calls went on to the address a redirect named", n)
	}
}
