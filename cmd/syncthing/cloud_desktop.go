// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/syncthing/syncthing/lib/config"
	"github.com/syncthing/syncthing/lib/events"
	"github.com/syncthing/syncthing/lib/locations"
	"github.com/syncthing/syncthing/lib/protocol"
	"github.com/syncthing/syncthing/lib/tlsutil"
)

const desktopMarker = "xun-cloud-isolated-desktop-v1\n"

type cloudInitDesktopCmd struct {
	SyncRoot string `required:"" help:"Absolute base directory for this isolated desktop instance's personal folders"`
}

type desktopBridge struct {
	GUIURL   string `json:"guiUrl"`
	APIKey   string `json:"apiKey"`
	CertFile string `json:"certFile"`
}

// stdout is a private bridge to the native parent process, never the webview.
func (c cloudInitDesktopCmd) Run() error {
	bridge, err := initDesktop(locations.GetBaseDir(locations.ConfigBaseDir), c.SyncRoot)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(bridge)
}

func initDesktop(home, syncRoot string) (desktopBridge, error) {
	if !filepath.IsAbs(home) || !filepath.IsAbs(syncRoot) {
		return desktopBridge{}, errors.New("absolute home and sync root required")
	}
	marker := filepath.Join(home, ".xun-cloud-desktop")
	if data, err := os.ReadFile(marker); err == nil {
		if string(data) != desktopMarker {
			return desktopBridge{}, errors.New("unrecognized desktop instance")
		}
	} else if os.IsNotExist(err) {
		entries, err := os.ReadDir(home)
		if err != nil && !os.IsNotExist(err) {
			return desktopBridge{}, err
		}
		if len(entries) != 0 {
			return desktopBridge{}, errors.New("refusing to adopt an existing non-desktop config directory")
		}
		if err := os.MkdirAll(home, 0o700); err != nil {
			return desktopBridge{}, err
		}
		if err := exclusiveWrite(marker, []byte(desktopMarker)); err != nil {
			return desktopBridge{}, err
		}
	} else {
		return desktopBridge{}, err
	}
	certPath, keyPath := filepath.Join(home, "cert.pem"), filepath.Join(home, "key.pem")
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		if _, e := os.Stat(certPath); !os.IsNotExist(e) {
			return desktopBridge{}, fmt.Errorf("cannot read device certificate: %w", err)
		}
		if _, e := os.Stat(keyPath); !os.IsNotExist(e) {
			return desktopBridge{}, errors.New("device private key exists without certificate")
		}
		cert, err = tlsutil.NewCertificate(certPath, keyPath, "syncthing", 3650, false)
		if err != nil {
			return desktopBridge{}, err
		}
	}
	id := protocol.NewDeviceID(cert.Certificate[0])
	cfgPath := filepath.Join(home, "config.xml")
	guiCert := filepath.Join(home, "https-cert.pem")
	guiKey := filepath.Join(home, "https-key.pem")
	caPath := filepath.Join(home, "https-ca.pem")
	if _, err := os.Stat(cfgPath); os.IsNotExist(err) {
		if err := createDesktopTLS(guiCert, guiKey, caPath); err != nil {
			return desktopBridge{}, err
		}
		cfg := config.New(id)
		port, err := desktopPort()
		if err != nil {
			return desktopBridge{}, err
		}
		cfg.GUI.RawAddress = fmt.Sprintf("127.0.0.1:%d", port)
		cfg.GUI.RawUseTLS = true
		cfg.GUI.User = "local-desktop"
		var password [32]byte
		if _, err := rand.Read(password[:]); err != nil {
			return desktopBridge{}, err
		}
		if err := cfg.GUI.SetPassword(hex.EncodeToString(password[:])); err != nil {
			return desktopBridge{}, err
		}
		cfg.Defaults.Folder.Path = syncRoot
		// Outbound TCP is enough for server-hub sync. No LAN discovery, public
		// listeners, NAT changes, telemetry or automatic upstream replacement.
		cfg.Options.RawListenAddresses = []string{"tcp://127.0.0.1:0"}
		cfg.Options.GlobalAnnEnabled = false
		cfg.Options.LocalAnnEnabled = false
		cfg.Options.NATEnabled = false
		cfg.Options.RelaysEnabled = false
		cfg.Options.StartBrowser = false
		cfg.Options.AutoUpgradeIntervalH = 0
		cfg.Options.CREnabled = false
		cfg.Options.URAccepted = -1
		if err := config.Wrap(cfgPath, cfg, id, events.NoopLogger).Save(); err != nil {
			return desktopBridge{}, err
		}
	} else if err != nil {
		return desktopBridge{}, err
	}
	w, _, err := config.Load(cfgPath, id, events.NoopLogger)
	if err != nil {
		return desktopBridge{}, err
	}
	gui := w.GUI()
	host, _, err := net.SplitHostPort(gui.Address())
	if err != nil || host != "127.0.0.1" || !gui.UseTLS() || !gui.IsAuthEnabled() || gui.InsecureAdminAccess || gui.APIKey == "" {
		return desktopBridge{}, errors.New("desktop GUI must use authenticated loopback HTTPS")
	}
	pair, err := tls.LoadX509KeyPair(guiCert, guiKey)
	if err != nil {
		return desktopBridge{}, err
	}
	if pair.Leaf == nil {
		pair.Leaf, err = x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return desktopBridge{}, err
		}
	}
	if err := pair.Leaf.VerifyHostname("127.0.0.1"); err != nil {
		return desktopBridge{}, err
	}
	if time.Now().After(pair.Leaf.NotAfter) {
		return desktopBridge{}, errors.New("local desktop certificate expired; renew before starting")
	}
	return desktopBridge{GUIURL: "https://" + gui.Address(), APIKey: gui.APIKey, CertFile: caPath}, nil
}

func desktopPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}
func exclusiveWrite(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closed := f.Close()
	if err != nil {
		return err
	}
	return closed
}
func createDesktopTLS(certPath, keyPath, caPath string) error {
	if _, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		if _, err := os.Stat(caPath); err != nil {
			return err
		}
		return nil
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "XunCloud desktop private trust"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(365 * 24 * time.Hour), KeyUsage: x509.KeyUsageCertSign, IsCA: true, BasicConstraintsValid: true, MaxPathLenZero: true}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	leaf := &x509.Certificate{SerialNumber: new(big.Int).Add(serial, big.NewInt(1)), Subject: pkix.Name{CommonName: "XunCloud local desktop"}, NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, DNSNames: []string{"localhost"}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, caKey)
	if err != nil {
		return err
	}
	priv, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err := exclusiveWrite(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: priv})); err != nil {
		return err
	}
	if err := exclusiveWrite(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})); err != nil {
		return err
	}
	// The local CA signing key is deliberately never persisted.
	return exclusiveWrite(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}
