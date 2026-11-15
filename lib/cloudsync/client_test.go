// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package cloudsync

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/syncthing/syncthing/lib/config"
	"github.com/syncthing/syncthing/lib/events"
	"github.com/syncthing/syncthing/lib/protocol"
	"github.com/syncthing/syncthing/lib/tlsutil"
)

func clientWrapper(t *testing.T, cert tls.Certificate) config.Wrapper {
	t.Helper()
	dir := t.TempDir()
	id := protocol.NewDeviceID(cert.Certificate[0])
	cfg := config.New(id)
	cfg.Defaults.Folder.Path = filepath.Join(dir, "data")
	if err := os.Mkdir(filepath.Join(dir, "config"), 0o700); err != nil {
		t.Fatal(err)
	}
	out := config.Wrap(filepath.Join(dir, "config", "config.xml"), cfg, id, events.NoopLogger)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = out.Serve(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	return out
}

func trustTestServer(t *testing.T, s *httptest.Server) {
	t.Helper()
	ca := filepath.Join(t.TempDir(), "test-ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XUNCLOUD_CA_FILE", ca)
}

func TestJoinTLSAndIdempotence(t *testing.T) {
	cert, err := tlsutil.NewCertificateInMemory("syncthing", 2)
	if err != nil {
		t.Fatal(err)
	}
	w := clientWrapper(t, cert)
	serverID := protocol.NewDeviceID([]byte("server"))
	folderID := "xc-12345678901234567890123456789012"
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.PeerCertificates) != 1 || protocol.NewDeviceID(r.TLS.PeerCertificates[0].Raw) != w.MyID() {
			t.Error("device proof missing")
		}
		if r.URL.Path != enrollPath {
			t.Error(r.URL)
		}
		if r.Header.Get("X-API-Key") != "" {
			t.Error("admin key leaked")
		}
		_ = json.NewEncoder(rw).Encode(grant{serverID, folderID, 22000})
	}))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13, ClientAuth: tls.RequireAnyClientCert}
	server.StartTLS()
	defer server.Close()
	in := JoinInput{server.URL, "alice", "alice-long-password"}
	t.Setenv("XUNCLOUD_CA_FILE", "")
	if _, err := Join(context.Background(), w, cert, in); err == nil {
		t.Fatal("accepted untrusted HTTPS")
	}
	trustTestServer(t, server)
	for range 2 {
		path, err := Join(context.Background(), w, cert, in)
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Base(path) != folderID {
			t.Fatal(path)
		}
	}
	f, ok := w.Folder(folderID)
	if !ok || len(f.Devices) != 2 {
		t.Fatal(f)
	}
	for _, d := range w.DeviceList() {
		if d.Introducer || d.AutoAcceptFolders {
			t.Fatal("excess privilege")
		}
	}
}

func TestJoinRejectsRedirectAndMalformedGrant(t *testing.T) {
	cert, err := tlsutil.NewCertificateInMemory("syncthing", 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{"redirect", `{"folderID":"../../config","syncPort":22000}`, strings.Repeat(" ", maxBody+1), `{} {}`} {
		t.Run(body[:min(12, len(body))], func(t *testing.T) {
			w := clientWrapper(t, cert)
			s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if body == "redirect" {
					http.Redirect(w, r, "https://evil.invalid/", 307)
					return
				}
				_, _ = w.Write([]byte(body))
			}))
			defer s.Close()
			trustTestServer(t, s)
			_, err := Join(context.Background(), w, cert, JoinInput{s.URL, "alice", "alice-long-password"})
			if err == nil {
				t.Fatal("accepted invalid grant")
			}
			if body == "redirect" && !strings.Contains(err.Error(), "307") {
				t.Fatal("followed redirect", err)
			}
			if len(w.FolderList()) != 0 {
				t.Fatal("changed config on invalid grant")
			}
		})
	}
}
