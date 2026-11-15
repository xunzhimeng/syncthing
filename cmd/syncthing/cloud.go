// Copyright (C) 2026 The Syncthing Authors.
// SPDX-License-Identifier: MPL-2.0

package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"

	"github.com/syncthing/syncthing/lib/cloudsync"
	"github.com/syncthing/syncthing/lib/locations"
)

type cloudCmd struct {
	InitDesktop cloudInitDesktopCmd `cmd:"" help:"Initialize an isolated Tauri desktop core; writes private bridge JSON to stdout"`
	AddUser     cloudAddUserCmd     `cmd:"" help:"Create an ordinary cloud sync account on this server (not a GUI administrator)"`
}

type cloudAddUserCmd struct {
	Username string `arg:"" help:"Account name"`
}

func (c cloudAddUserCmd) Run() error {
	var password []byte
	var err error
	if fd := int(os.Stdin.Fd()); term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, "New cloud account password (12–72 bytes): ")
		password, err = term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
	} else {
		var line string
		line, err = bufio.NewReader(io.LimitReader(os.Stdin, 75)).ReadString('\n')
		if errors.Is(err, io.EOF) {
			err = nil
		}
		password = []byte(strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"))
	}
	if err != nil {
		return err
	}
	defer clear(password)
	return cloudsync.CreateAccount(locations.GetBaseDir(locations.ConfigBaseDir), c.Username, password)
}
