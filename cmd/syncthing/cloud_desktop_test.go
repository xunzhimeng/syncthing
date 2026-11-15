// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package main

import (
	"crypto/tls"
	"crypto/x509"
	"os"
	"path/filepath"
	"testing"

	"github.com/syncthing/syncthing/lib/config"
	"github.com/syncthing/syncthing/lib/events"
	"github.com/syncthing/syncthing/lib/protocol"
)

func TestDesktopInit(t *testing.T) {
	home := filepath.Join(t.TempDir(), "core")
	root := filepath.Join(t.TempDir(), "files")
	a, err := initDesktop(home, root)
	if err != nil {
		t.Fatal(err)
	}
	b, err := initDesktop(home, root)
	if err != nil {
		t.Fatal(err)
	}
	if a != b || a.APIKey == "" {
		t.Fatal("non-idempotent desktop init")
	}
	cert, err := tls.LoadX509KeyPair(filepath.Join(home, "cert.pem"), filepath.Join(home, "key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	cfg, _, err := config.Load(filepath.Join(home, "config.xml"), protocol.NewDeviceID(cert.Certificate[0]), events.NoopLogger)
	if err != nil {
		t.Fatal(err)
	}
	o := cfg.Options()
	if o.GlobalAnnEnabled || o.LocalAnnEnabled || o.RelaysEnabled || o.NATEnabled || o.CREnabled || o.AutoUpgradeIntervalH != 0 {
		t.Fatal("unexpected external services")
	}
	pem, err := os.ReadFile(a.CertFile)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		t.Fatal("invalid certificate")
	}
	local, err := tls.LoadX509KeyPair(filepath.Join(home, "https-cert.pem"), filepath.Join(home, "https-key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := local.Leaf.Verify(x509.VerifyOptions{DNSName: "127.0.0.1", Roots: pool}); err != nil {
		t.Fatal(err)
	}
	if _, err := local.Leaf.Verify(x509.VerifyOptions{DNSName: "192.0.2.1", Roots: pool}); err == nil {
		t.Fatal("unexpected remote identity")
	}
}
func TestDesktopRefusesExistingConfig(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.xml"), []byte("untouched"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := initDesktop(home, t.TempDir()); err == nil {
		t.Fatal("adopted existing directory")
	}
	got, _ := os.ReadFile(filepath.Join(home, "config.xml"))
	if string(got) != "untouched" {
		t.Fatal("changed existing config")
	}
}
