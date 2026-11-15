// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package cloudsync

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/syncthing/syncthing/lib/config"
	"github.com/syncthing/syncthing/lib/fs"
	"github.com/syncthing/syncthing/lib/protocol"
)

// JoinInput is used only on the client's local, CSRF-protected management API.
// There is deliberately no remote device ID, API key, directory or CA override
// in the wire protocol. Never log this struct.
type JoinInput struct {
	Server   string `json:"server"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func endpoint(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		if ip := net.ParseIP(raw); ip != nil && strings.Contains(raw, ":") {
			raw = "[" + raw + "]"
		}
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Hostname() == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return nil, errors.New("enter an HTTPS host or IP, optionally with a port, without credentials or a path")
	}
	if u.Port() == "" {
		u.Host = net.JoinHostPort(u.Hostname(), "8443")
	} else if port, err := strconv.Atoi(u.Port()); err != nil || port < 1 || port > 65535 {
		return nil, errors.New("invalid enrollment port")
	}
	u.Path = enrollPath
	return u, nil
}

func Join(ctx context.Context, w config.Wrapper, cert tls.Certificate, in JoinInput) (string, error) {
	u, err := endpoint(in.Server)
	if err != nil {
		return "", err
	}
	if !validUsername.MatchString(in.Username) || len(in.Password) == 0 || len(in.Password) > 72 {
		return "", errors.New("invalid username or password format")
	}
	if len(cert.Certificate) == 0 || protocol.NewDeviceID(cert.Certificate[0]) != w.MyID() {
		return "", errors.New("local device certificate is not available")
	}
	var roots *x509.CertPool
	if path := os.Getenv("XUNCLOUD_CA_FILE"); path != "" {
		pem, err := os.ReadFile(path)
		roots = x509.NewCertPool()
		if err != nil || !roots.AppendCertsFromPEM(pem) {
			return "", errors.New("cannot load configured cloud CA file")
		}
	}
	tr := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, Certificates: []tls.Certificate{cert}}, DisableKeepAlives: true}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	body, err := json.Marshal(credentials{in.Username, in.Password})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("cloud connection or TLS verification failed: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return "", errors.New("incorrect account or password")
	case http.StatusConflict:
		return "", errConflict
	case http.StatusTooManyRequests:
		return "", errors.New("too many logins; try again later")
	default:
		return "", fmt.Errorf("enrollment server returned HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	var g grant
	if err != nil || len(data) > maxBody || decode(bytes.NewReader(data), &g) != nil || !validFolderID.MatchString(g.FolderID) || g.SyncPort < 1 || g.SyncPort > 65535 {
		return "", errors.New("invalid cloud enrollment response")
	}
	base := w.DefaultFolder().Path
	if base == "" {
		base = "~"
	}
	base, err = fs.ExpandTilde(base)
	if err != nil {
		return "", err
	}
	base, err = filepath.Abs(base)
	if err != nil {
		return "", err
	}
	b := binding{username: in.Username, folderID: g.FolderID, root: filepath.Join(base, "XunCloud"), peer: g.ServerID, address: "tcp://" + net.JoinHostPort(u.Hostname(), strconv.Itoa(g.SyncPort))}
	return b.apply(w)
}
