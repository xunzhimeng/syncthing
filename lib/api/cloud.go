// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package api

import (
	"crypto/tls"
	"encoding/json"
	"io"
	"net/http"

	"github.com/syncthing/syncthing/lib/cloudsync"
	"github.com/syncthing/syncthing/lib/locations"
)

// This is a client-side operation, behind normal GUI auth and CSRF. Never
// allow another host to make the local daemon enroll its identity or read a
// user's cloud password over a network GUI connection.
func (s *service) postCloudJoin(w http.ResponseWriter, r *http.Request) {
	if !addressIsLocalhost(r.RemoteAddr) || !addressIsLocalhost(r.Host) {
		http.Error(w, "open the local device's GUI on loopback to join", http.StatusForbidden)
		return
	}
	var in cloudsync.JoinInput
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	d.DisallowUnknownFields()
	if err := d.Decode(&in); err != nil || d.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid login request", http.StatusBadRequest)
		return
	}
	cert, err := tls.LoadX509KeyPair(locations.Get(locations.CertFile), locations.Get(locations.KeyFile))
	if err != nil {
		http.Error(w, "local device key unavailable", http.StatusServiceUnavailable)
		return
	}
	path, err := cloudsync.Join(r.Context(), s.cfg, cert, in)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	sendJSON(w, map[string]string{"path": path})
}
