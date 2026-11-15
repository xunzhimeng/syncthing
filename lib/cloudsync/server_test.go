// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package cloudsync

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/time/rate"

	"github.com/syncthing/syncthing/lib/tlsutil"
)

func TestEnrollmentRateAndBodyLimits(t *testing.T) {
	cert, err := tlsutil.NewCertificateInMemory("syncthing", 2)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{limiter: rate.NewLimiter(0, 1), workers: make(chan struct{}, 1)}
	for i, code := range []int{400, 429} {
		r := httptest.NewRequest("POST", "https://localhost/v1/enroll", strings.NewReader(strings.Repeat("a", maxBody+1)))
		r.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{cert.Leaf}}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != code {
			t.Fatalf("request %d: got %d want %d", i, w.Code, code)
		}
	}
}

func TestUnknownEnrollmentRoutes(t *testing.T) {
	for _, path := range []string{"/rest/config", "/v1/enroll?token=x", "/v1/enroll/", "/v1/register"} {
		r := httptest.NewRequest("POST", "https://localhost"+path, strings.NewReader(`{}`))
		w := httptest.NewRecorder()
		new(Server).ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Fatal(path, w.Code)
		}
	}
}
