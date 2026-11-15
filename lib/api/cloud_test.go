// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/syncthing/syncthing/internal/db"
	"github.com/syncthing/syncthing/internal/db/sqlite"
	"github.com/syncthing/syncthing/lib/cloudsync"
	"github.com/syncthing/syncthing/lib/config"
)

func TestCloudJoinLocalOnly(t *testing.T) {
	for _, tc := range []struct {
		remote, host string
		code         int
	}{
		{"192.0.2.3:1234", "127.0.0.1:8384", 403},
		{"127.0.0.1:1234", "evil.example:8384", 403},
		{"127.0.0.1:1234", "localhost:8384", 400},
	} {
		r := httptest.NewRequest("POST", "http://"+tc.host+"/rest/cloud/join", strings.NewReader("not json"))
		r.RemoteAddr = tc.remote
		w := httptest.NewRecorder()
		new(service).postCloudJoin(w, r)
		if w.Code != tc.code {
			t.Fatal(tc, w.Code)
		}
	}
}

func TestCloudJoinRequiresCSRF(t *testing.T) {
	if isNoAuthPath("/rest/cloud/join", false) {
		t.Fatal("cloud join bypasses GUI authentication")
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("CSRF bypass") })
	mdb, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = mdb.Close() })
	mw := newCsrfManager("cloud", "/rest", config.GUIConfiguration{}, next, db.NewMiscDB(mdb))
	r := httptest.NewRequest("POST", "http://localhost/rest/cloud/join", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	mw.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}

func TestCloudAccountDoesNotAuthenticateGUI(t *testing.T) {
	dir := t.TempDir()
	if err := cloudsync.CreateAccount(dir, "alice", []byte("alice-long-password")); err != nil {
		t.Fatal(err)
	}
	cfg := config.GUIConfiguration{User: "administrator"}
	if err := cfg.SetPassword("administrator-password"); err != nil {
		t.Fatal(err)
	}
	if authStatic("alice", "alice-long-password", cfg) {
		t.Fatal("cloud account obtained GUI access")
	}
}
