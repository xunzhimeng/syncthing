// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package cloudsync

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/syncthing/syncthing/lib/config"
	"github.com/syncthing/syncthing/lib/fs"
	"github.com/syncthing/syncthing/lib/locations"
	"github.com/syncthing/syncthing/lib/protocol"
)

var errConflict = errors.New("device or folder already has a different binding, or its path is unsafe")

// canonical resolves links in existing ancestors, including when the proposed
// leaf does not yet exist (notably /var on macOS). Do not follow dangling links.
func canonical(path string) (string, error) {
	p, err := fs.ExpandTilde(path)
	if err != nil {
		return "", err
	}
	p, err = filepath.Abs(p)
	if err != nil {
		return "", err
	}
	return resolve(p)
}

func resolve(p string) (string, error) {
	_, err := os.Lstat(p)
	if err == nil {
		return filepath.EvalSymlinks(p)
	}
	if !os.IsNotExist(err) || filepath.Dir(p) == p {
		return "", err
	}
	parent, err := resolve(filepath.Dir(p))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(p)), nil
}

// Be conservative on case-insensitive volumes, even when mounted on Linux.
func overlaps(a, b string) bool {
	a, b = strings.ToLower(filepath.Clean(a)), strings.ToLower(filepath.Clean(b))
	return a == b || fs.IsParent(a, b) || fs.IsParent(b, a)
}

type binding struct {
	username, folderID, root string
	peer                     protocol.DeviceID
	address                  string // empty on the server (dynamic peer), static TCP on the client
}

func (b binding) apply(w config.Wrapper) (string, error) {
	if !validUsername.MatchString(b.username) || !validFolderID.MatchString(b.folderID) || !filepath.IsAbs(b.root) || b.peer == w.MyID() || b.peer == protocol.EmptyDeviceID || b.peer == protocol.LocalDeviceID || b.peer == protocol.GlobalDeviceID {
		return "", errConflict
	}
	root, err := canonical(b.root)
	if err != nil {
		return "", err
	}
	leaf := b.folderID
	if b.address == "" {
		leaf = "user-" + b.username
	}
	path := filepath.Join(root, leaf)
	for _, p := range []string{filepath.Dir(w.ConfigPath()), locations.GetBaseDir(locations.DataBaseDir)} {
		protected, err := canonical(p)
		if err != nil {
			return "", err
		}
		if overlaps(path, protected) {
			return "", errConflict
		}
	}
	var applyErr error
	waiter, err := w.Modify(func(cfg *config.Configuration) {
		applyErr = b.configure(cfg, w.MyID(), path)
	})
	if err != nil {
		return "", err
	}
	if applyErr != nil {
		return "", applyErr
	}
	waiter.Wait()
	// Do not acknowledge enrollment until the config is durable. A failed
	// response can be retried without duplicating either the folder or device.
	if err := w.Save(); err != nil {
		return "", err
	}
	return path, nil
}

// Called inside a single queued config update; never partially mutate cfg on
// error. Do not inherit template devices, auto-accept, introducer or versioner.
func (b binding) configure(cfg *config.Configuration, self protocol.DeviceID, path string) error {
	f, _, exists := cfg.Folder(b.folderID)
	for _, other := range cfg.Folders {
		otherPath, err := canonical(other.Path)
		if err != nil {
			return fmt.Errorf("checking existing folder: %w", err)
		}
		if other.ID == b.folderID {
			if otherPath != path || other.Type != config.FolderTypeSendReceive || other.FilesystemType != config.FilesystemTypeBasic {
				return errConflict
			}
		} else {
			if overlaps(otherPath, path) {
				return errConflict
			}
			if _, shared := other.Device(b.peer); shared {
				return errConflict
			}
		}
	}
	for _, d := range cfg.Devices {
		if d.DeviceID != b.peer && d.DeviceID.Short() == b.peer.Short() {
			return errConflict
		}
	}
	dev, _, known := cfg.Device(b.peer)
	_, shared := f.Device(b.peer)
	if known && (!exists || !shared || dev.Introducer || dev.AutoAcceptFolders || dev.Untrusted) {
		return errConflict
	}
	if b.address != "" && exists {
		// Never let a remote enrollment response select an existing local folder
		// unless it is already shared exclusively with this server.
		if !known || !shared {
			return errConflict
		}
		for _, member := range f.Devices {
			if member.DeviceID != self && member.DeviceID != b.peer {
				return errConflict
			}
		}
	}
	if !shared && len(f.Devices) >= 65 {
		return errors.New("account device limit reached")
	}
	if exists {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() {
			return errConflict
		}
	} else {
		if err := freshDirectory(path); err != nil {
			return err
		}
		f = config.New(self).Defaults.Folder
		f.ID, f.Path, f.Label = b.folderID, path, "XunCloud - "+b.username
		f.Devices = []config.FolderDeviceConfiguration{{DeviceID: self}}
	}
	if !known {
		dev = config.DeviceConfiguration{DeviceID: b.peer, Name: "XunCloud - " + b.username}
	}
	if b.address != "" {
		dev.Addresses = []string{b.address}
	}
	if !shared {
		f.Devices = append(f.Devices, config.FolderDeviceConfiguration{DeviceID: b.peer})
	}
	cfg.SetDevice(dev)
	cfg.SetFolder(f)
	return nil
}

func freshDirectory(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	err := os.Mkdir(path, 0o700)
	if !os.IsExist(err) {
		return err
	}
	// A previous interrupted enrollment may have made an empty directory.
	// Never adopt a link, a file, or pre-existing user data.
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		return errConflict
	}
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	if _, err = d.Readdirnames(1); err != io.EOF {
		return errConflict
	}
	return nil
}
