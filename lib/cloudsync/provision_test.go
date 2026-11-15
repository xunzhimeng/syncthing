// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package cloudsync

import (
	"path/filepath"
	"testing"

	"github.com/syncthing/syncthing/lib/config"
	"github.com/syncthing/syncthing/lib/protocol"
)

func TestProvisionDoesNotInheritTemplatePrivileges(t *testing.T) {
	w := testWrapper(t)
	rogue := protocol.NewDeviceID([]byte("unrelated-peer"))
	waiter, err := w.Modify(func(c *config.Configuration) {
		c.SetDevice(config.DeviceConfiguration{DeviceID: rogue})
		c.Defaults.Device.Introducer = true
		c.Defaults.Device.AutoAcceptFolders = true
		c.Defaults.Folder.Devices = append(c.Defaults.Folder.Devices, config.FolderDeviceConfiguration{DeviceID: rogue})
		c.Defaults.Folder.Type = config.FolderTypeSendOnly
		c.Defaults.Folder.Versioning.Type = "external"
	})
	if err != nil {
		t.Fatal(err)
	}
	waiter.Wait()
	id := accountID(t, filepath.Dir(w.ConfigPath()), "alice")
	peer := protocol.NewDeviceID([]byte("alice-peer"))
	b := binding{"alice", id, filepath.Join(filepath.Dir(filepath.Dir(w.ConfigPath())), "users"), peer, ""}
	if _, err := b.apply(w); err != nil {
		t.Fatal(err)
	}
	f, _ := w.Folder(id)
	if len(f.Devices) != 2 || f.Type != config.FolderTypeSendReceive || f.Versioning.Type != "" {
		t.Fatal("unsafe defaults inherited", f)
	}
	if _, ok := f.Device(rogue); ok {
		t.Fatal("inherited unrelated share")
	}
	d, _ := w.Device(peer)
	if d.Introducer || d.AutoAcceptFolders {
		t.Fatal("inherited elevated peer privileges")
	}
}

func TestClientRejectsFolderHijack(t *testing.T) {
	w := testWrapper(t)
	root := filepath.Join(filepath.Dir(filepath.Dir(w.ConfigPath())), "users")
	id := "xc-11111111111111111111111111111111"
	original := protocol.NewDeviceID([]byte("original-server"))
	b := binding{"alice", id, root, original, "tcp://127.0.0.1:22000"}
	if _, err := b.apply(w); err != nil {
		t.Fatal(err)
	}
	b.peer = protocol.NewDeviceID([]byte("evil-server"))
	if _, err := b.apply(w); err == nil {
		t.Fatal("new server gained access to existing cloud data")
	}
	f, _ := w.Folder(id)
	if _, ok := f.Device(b.peer); ok {
		t.Fatal("malicious device added")
	}
}
