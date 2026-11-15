// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

// Package cloudsync provisions ordinary Syncthing devices and folders after
// account authentication. It does not grant access to the management GUI.
package cloudsync

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"golang.org/x/crypto/bcrypt"
)

var (
	validUsername = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	validFolderID = regexp.MustCompile(`^xc-[0-9a-f]{32}$`)
)

type account struct {
	FolderID string `json:"folderID"`
	Hash     string `json:"passwordHash"`
}

// CreateAccount is an administrator operation on the server filesystem only.
// Prefixing the filename also avoids reserved device names on Windows.
func CreateAccount(configDir, username string, password []byte) error {
	if !validUsername.MatchString(username) {
		return errors.New("username must start with a lowercase letter and contain only a-z, 0-9, _ or - (max 32 characters)")
	}
	if len(password) < 12 || len(password) > 72 {
		return errors.New("password must be between 12 and 72 bytes")
	}
	hash, err := bcrypt.GenerateFromPassword(password, bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return err
	}
	dir := filepath.Join(configDir, "cloud-accounts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	name := filepath.Join(dir, "user-"+username+".json")
	f, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		return errors.New("account already exists; not overwritten")
	}
	if err != nil {
		return err
	}
	err = json.NewEncoder(f).Encode(account{FolderID: "xc-" + hex.EncodeToString(id[:]), Hash: string(hash)})
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("writing new account: %w", err)
	}
	return nil
}

func authenticate(dir, username, password string, dummy []byte) (account, bool) {
	var a account
	if validUsername.MatchString(username) && len(password) <= 72 {
		bs, err := os.ReadFile(filepath.Join(dir, "cloud-accounts", "user-"+username+".json"))
		if err == nil && json.Unmarshal(bs, &a) == nil && validFolderID.MatchString(a.FolderID) {
			return a, bcrypt.CompareHashAndPassword([]byte(a.Hash), []byte(password)) == nil
		}
	}
	// Unknown accounts incur the same password work and get the same response.
	_ = bcrypt.CompareHashAndPassword(dummy, []byte("invalid"))
	return account{}, false
}
