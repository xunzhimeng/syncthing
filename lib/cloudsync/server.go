// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package cloudsync

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/time/rate"

	"github.com/syncthing/syncthing/lib/config"
	"github.com/syncthing/syncthing/lib/protocol"
)

const enrollPath = "/v1/enroll"
const maxBody = 4096

// Options only has an effect on nodes explicitly started as account servers.
type Options struct {
	Listen, CertFile, KeyFile, Root string
	SyncPort                        int
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type grant struct {
	ServerID protocol.DeviceID `json:"serverID"`
	FolderID string            `json:"folderID"`
	SyncPort int               `json:"syncPort"`
}

type Server struct {
	cfg      config.Wrapper
	opts     Options
	cert     tls.Certificate
	dummy    []byte
	limiter  *rate.Limiter
	workers  chan struct{}
	first    sync.Once
	ready    chan struct{}
	startErr error
}

func NewServer(cfg config.Wrapper, opts Options) (*Server, error) {
	if opts.Listen == "" || !filepath.IsAbs(opts.Root) || opts.SyncPort < 1 || opts.SyncPort > 65535 {
		return nil, errors.New("cloud listen address, absolute data root and valid sync port required")
	}
	cert, err := tls.LoadX509KeyPair(opts.CertFile, opts.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("cloud HTTPS certificate: %w", err)
	}
	dummy, err := bcrypt.GenerateFromPassword([]byte("never an account"), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	return &Server{cfg: cfg, opts: opts, cert: cert, dummy: dummy, limiter: rate.NewLimiter(3, 12), workers: make(chan struct{}, 4), ready: make(chan struct{})}, nil
}

func (s *Server) WaitForStart() error { <-s.ready; return s.startErr }

func (s *Server) Serve(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.opts.Listen)
	s.first.Do(func() { s.startErr = err; close(s.ready) })
	if err != nil {
		return err
	}
	// Unlike the GUI listener, never accept plaintext. TLS verifies possession
	// of the self-signed BEP key; the password authorizes this new identity.
	srv := &http.Server{Handler: s, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS13, ClientAuth: tls.RequireAnyClientCert, Certificates: []tls.Certificate{s.cert}}, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 8192}
	defer srv.Close()
	stop := context.AfterFunc(ctx, func() { _ = srv.Close() })
	defer stop()
	slog.Info("Cloud account enrollment listening", "address", ln.Addr().String())
	err = srv.Serve(tls.NewListener(ln, srv.TLSConfig))
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path != enrollPath || r.URL.RawQuery != "" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	if r.TLS == nil || len(r.TLS.PeerCertificates) != 1 {
		http.Error(w, "device certificate required", http.StatusUnauthorized)
		return
	}
	if !s.limiter.Allow() {
		w.Header().Set("Retry-After", "2")
		http.Error(w, "try again later", http.StatusTooManyRequests)
		return
	}
	select {
	case s.workers <- struct{}{}:
		defer func() { <-s.workers }()
	default:
		http.Error(w, "try again later", http.StatusTooManyRequests)
		return
	}
	var c credentials
	if err := decode(http.MaxBytesReader(w, r.Body, maxBody), &c); err != nil {
		http.Error(w, "invalid enrollment request", http.StatusBadRequest)
		return
	}
	a, ok := authenticate(filepath.Dir(s.cfg.ConfigPath()), c.Username, c.Password, s.dummy)
	if !ok {
		http.Error(w, "invalid login", http.StatusUnauthorized)
		return
	}
	peer := protocol.NewDeviceID(r.TLS.PeerCertificates[0].Raw)
	b := binding{username: c.Username, folderID: a.FolderID, root: s.opts.Root, peer: peer}
	if _, err := b.apply(s.cfg); err != nil {
		if errors.Is(err, errConflict) {
			http.Error(w, "device or folder conflict", http.StatusConflict)
			return
		}
		slog.Warn("Could not provision cloud folder", "error", err)
		http.Error(w, "could not provision folder", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(grant{ServerID: s.cfg.MyID(), FolderID: a.FolderID, SyncPort: s.opts.SyncPort})
}

func decode(r io.Reader, v any) error {
	d := json.NewDecoder(r)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected trailing data")
	}
	return nil
}
