// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package cloudsync

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/time/rate"

	"github.com/syncthing/syncthing/lib/config"
	"github.com/syncthing/syncthing/lib/events"
	"github.com/syncthing/syncthing/lib/protocol"
	"github.com/syncthing/syncthing/lib/tlsutil"
)

func testWrapper(t *testing.T) config.Wrapper {
	t.Helper()
	id := protocol.NewDeviceID([]byte(t.Name()))
	dir := t.TempDir()
	cfg := config.New(id)
	cfg.Defaults.Folder.Path = filepath.Join(dir, "data")
	path := filepath.Join(dir, "config", "config.xml")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	w := config.Wrap(path, cfg, id, events.NoopLogger)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = w.Serve(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	return w
}

func accountID(t *testing.T, dir, user string) string {
	t.Helper()
	if err := CreateAccount(dir, user, []byte("twelve-characters-password")); err != nil {
		t.Fatal(err)
	}
	a, ok := authenticate(dir, user, "twelve-characters-password", nil)
	if !ok {
		t.Fatal("authentication failed")
	}
	return a.FolderID
}

func TestAccount(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"../escape", "", "A", "a/b", "a\\b", "a@b"} {
		if err := CreateAccount(dir, name, []byte("twelve-characters-password")); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	if err := CreateAccount(dir, "alice", []byte("short")); err == nil {
		t.Fatal("accepted short password")
	}
	id := accountID(t, dir, "alice")
	if !validFolderID.MatchString(id) {
		t.Fatal(id)
	}
	if err := CreateAccount(dir, "alice", []byte("twelve-characters-password")); err == nil {
		t.Fatal("overwrote account")
	}
	if _, ok := authenticate(dir, "alice", "wrong", nil); ok {
		t.Fatal("wrong password accepted")
	}
	if _, ok := authenticate(dir, "absent", "wrong", nil); ok {
		t.Fatal("absent account accepted")
	}
	bs, _ := os.ReadFile(filepath.Join(dir, "cloud-accounts", "user-alice.json"))
	if bytes.Contains(bs, []byte("twelve-characters-password")) {
		t.Fatal("plaintext password saved")
	}
}

func TestProvisionIsolationAndPersistence(t *testing.T) {
	w := testWrapper(t)
	root := filepath.Join(filepath.Dir(filepath.Dir(w.ConfigPath())), "server-data")
	a := accountID(t, filepath.Dir(w.ConfigPath()), "alice")
	b := accountID(t, filepath.Dir(w.ConfigPath()), "bob")
	d1, d2, d3 := protocol.NewDeviceID([]byte("1")), protocol.NewDeviceID([]byte("2")), protocol.NewDeviceID([]byte("3"))
	for _, binding := range []binding{{"alice", a, root, d1, ""}, {"alice", a, root, d2, ""}, {"bob", b, root, d3, ""}, {"alice", a, root, d1, ""}} {
		if _, err := binding.apply(w); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := (binding{"bob", b, root, d1, ""}).apply(w); err == nil {
		t.Fatal("cross-account device reuse accepted")
	}
	for _, tc := range []struct {
		id        string
		want, not protocol.DeviceID
	}{{a, d1, d3}, {b, d3, d1}} {
		f, _ := w.Folder(tc.id)
		if _, ok := f.Device(tc.want); !ok {
			t.Fatal("expected member missing")
		}
		if _, ok := f.Device(tc.not); ok {
			t.Fatal("cross-account sharing")
		}
	}
	cfg, _, err := config.Load(w.ConfigPath(), w.MyID(), events.NoopLogger)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.FolderList()) != 2 || len(cfg.DeviceList()) != 4 {
		t.Fatal("duplicate or missing provisioning")
	}
	for _, d := range cfg.DeviceList() {
		if d.AutoAcceptFolders || d.Introducer {
			t.Fatal("excess permissions")
		}
	}
}

func TestProvisionConcurrentAndRejectExistingData(t *testing.T) {
	w := testWrapper(t)
	root := filepath.Join(filepath.Dir(filepath.Dir(w.ConfigPath())), "data")
	id := accountID(t, filepath.Dir(w.ConfigPath()), "alice")
	b := binding{"alice", id, root, protocol.NewDeviceID([]byte("client")), ""}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := b.apply(w); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	f, _ := w.Folder(id)
	if len(f.Devices) != 2 {
		t.Fatal("duplicate membership")
	}
	bob := binding{"bob", "xc-22222222222222222222222222222222", root, protocol.NewDeviceID([]byte("bob")), ""}
	path := filepath.Join(root, "user-bob")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "private.txt"), []byte("untouched"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := w.RawCopy()
	if _, err := bob.apply(w); err == nil {
		t.Fatal("adopted existing data")
	}
	if !reflect.DeepEqual(before, w.RawCopy()) {
		t.Fatal("mutated on failure")
	}
}

func TestRejectSymlinkAndOverlap(t *testing.T) {
	w := testWrapper(t)
	root := filepath.Join(filepath.Dir(filepath.Dir(w.ConfigPath())), "sync")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "user-alice")); err != nil {
		t.Skip(err)
	}
	b := binding{"alice", "xc-11111111111111111111111111111111", root, protocol.NewDeviceID([]byte("a")), ""}
	if _, err := b.apply(w); err == nil {
		t.Fatal("followed leaf symlink")
	}
	b.root = filepath.Dir(w.ConfigPath())
	if _, err := b.apply(w); err == nil {
		t.Fatal("shared configuration directory")
	}
	before := w.RawCopy()
	before.Folders = append(before.Folders, config.FolderConfiguration{ID: "legacy", Path: root})
	canonicalRoot, err := canonical(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.configure(&before, w.MyID(), filepath.Join(canonicalRoot, "user-charlie")); err == nil {
		t.Fatal("nested folder accepted")
	}
}

func TestEndpoint(t *testing.T) {
	for _, input := range []string{"192.0.2.1", "https://cloud.example:8443", "[::1]", "::1"} {
		if _, err := endpoint(input); err != nil {
			t.Fatal(input, err)
		}
	}
	for _, input := range []string{"http://example", "https://a:b@example", "https://example/path", "https://example?token=secret", "https://example#bad", "https://example:0", "https://example:65536", ""} {
		if _, err := endpoint(input); err == nil {
			t.Fatal("accepted", input)
		}
	}
}

func TestServerAuthorization(t *testing.T) {
	w := testWrapper(t)
	accountID(t, filepath.Dir(w.ConfigPath()), "alice")
	dummy, _ := bcrypt.GenerateFromPassword([]byte("dummy"), bcrypt.DefaultCost)
	s := &Server{cfg: w, opts: Options{Root: filepath.Join(filepath.Dir(filepath.Dir(w.ConfigPath())), "server"), SyncPort: 22000}, dummy: dummy, limiter: rate.NewLimiter(rate.Inf, 20), workers: make(chan struct{}, 4)}
	cert, err := tlsutil.NewCertificateInMemory("syncthing", 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, method, body string
		tls                bool
		status             int
	}{
		{enrollPath, "POST", `{"username":"alice","password":"wrong"}`, true, 401},
		{enrollPath, "POST", `{"username":"absent","password":"wrong"}`, true, 401},
		{enrollPath, "POST", `{}`, false, 401},
		{enrollPath, "GET", `{}`, true, 405},
		{"/rest/config", "GET", `{}`, true, 404},
		{enrollPath, "POST", `{"username":"alice","password":"twelve-characters-password","deviceID":"victim"}`, true, 400},
		{enrollPath, "POST", `{"username":"alice","password":"twelve-characters-password"}`, true, 200},
	} {
		r := httptest.NewRequest(tc.method, "https://localhost"+tc.path, strings.NewReader(tc.body))
		if tc.tls {
			r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{cert.Leaf}}
		} else {
			r.TLS = nil
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body.String())
		}
		if w.Code == http.StatusOK {
			var g map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &g); err != nil {
				t.Fatal(err)
			}
			if len(g) != 3 {
				t.Fatal("unexpected enrollment fields", g)
			}
		}
	}
}
