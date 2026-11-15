#!/usr/bin/env python3
"""Isolated account-sync acceptance test. No production config/ports are used.
Run: python3 test/cloud_account_e2e.py tmp/cloud-tools/syncthing
Fixtures and diagnostic logs stay under tmp/; all started processes are stopped.
"""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

BINARY = Path(sys.argv[1]).resolve()
Path("tmp").mkdir(exist_ok=True)
ROOT = Path(tempfile.mkdtemp(prefix="cloud-e2e-", dir="tmp")).resolve()
ADMIN_PASSWORD = secrets.token_urlsafe(24)
ALICE_PASSWORD = secrets.token_urlsafe(24)
BOB_PASSWORD = secrets.token_urlsafe(24)
processes = []
logs = []
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run(args, password=None):
    return subprocess.run([str(BINARY)] + args, input=(password + "\n") if password else None,
                          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)


def request(node, path, body=None, key=True):
    req = urllib.request.Request(node["url"] + "/rest/" + path,
                                 data=json.dumps(body).encode() if body is not None else None)
    if key:
        req.add_header("X-API-Key", node["key"])
    req.add_header("Content-Type", "application/json")
    with opener.open(req, timeout=30) as response:
        data = response.read()
        return json.loads(data) if data else None


def wait_for(fn, desc, timeout=90):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if fn():
                return
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            pass
        for process in processes:
            if process.poll() is not None:
                raise RuntimeError("instance exited unexpectedly; see " + str(ROOT))
        time.sleep(0.3)
    raise AssertionError("timed out: " + desc)


def generate(name):
    home = ROOT / name
    home.mkdir()
    run(["--home", str(home), "generate", "--no-port-probing", "--gui-user", "admin", "--gui-password", "-"], ADMIN_PASSWORD)
    path = home / "config.xml"
    tree = ET.parse(path)
    cfg = tree.getroot()
    gui_port, sync_port = port(), port()
    gui = cfg.find("gui")
    gui.set("tls", "false")
    gui.find("address").text = "127.0.0.1:" + str(gui_port)
    opts = cfg.find("options")
    for child in list(opts.findall("listenAddress")):
        opts.remove(child)
    ET.SubElement(opts, "listenAddress").text = "tcp://127.0.0.1:" + str(sync_port)
    values = {"globalAnnounceEnabled": "false", "localAnnounceEnabled": "false",
              "relaysEnabled": "false", "natEnabled": "false", "startBrowser": "false",
              "crashReportingEnabled": "false", "autoUpgradeIntervalH": "0", "urAccepted": "-1"}
    for key, value in values.items():
        element = opts.find(key)
        if element is None:
            element = ET.SubElement(opts, key)
        element.text = value
    cfg.find("defaults/folder").set("path", str(ROOT / (name + "-files")))
    tree.write(path, encoding="utf-8")
    return {"home": home, "url": "http://127.0.0.1:" + str(gui_port), "sync": sync_port,
            "key": gui.find("apikey").text, "extra": []}


def start(node):
    log = open(node["home"] / "e2e.log", "ab")
    logs.append(log)
    env = os.environ.copy()
    for name in list(env):
        if name.startswith(("ST", "XUNCLOUD_")):
            del env[name]
    env["XUNCLOUD_CA_FILE"] = str(ROOT / "tls.pem")
    p = subprocess.Popen([str(BINARY), "--home", str(node["home"]), "serve", "--no-browser", "--no-restart", "--no-upgrade"] + node["extra"],
                         env=env, stdout=log, stderr=log)
    node["process"] = p
    processes.append(p)
    wait_for(lambda: request(node, "system/ping").get("ping") == "pong", "GUI readiness")


def stop(node):
    p = node["process"]
    p.terminate()
    p.wait(timeout=20)
    processes.remove(p)
    if p.returncode != 0:
        raise RuntimeError("nonzero instance shutdown: " + str(p.returncode))


def join(node, user, password):
    response = request(node, "cloud/join", {"server": "127.0.0.1:" + str(enroll_port), "username": user, "password": password})
    return response["path"]


try:
    print("Fixtures:", ROOT, flush=True)
    # Never inherit a user's configured service paths or address overrides.
    for name in list(os.environ):
        if name.startswith(("ST", "XUNCLOUD_")):
            del os.environ[name]
    cfg = ROOT / "tls.cnf"
    cfg.write_text("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", str(cfg), "-keyout", str(ROOT / "tls.key"), "-out", str(ROOT / "tls.pem")], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    server, a, b, outsider = [generate(x) for x in ("server", "alice1", "alice2", "bob")]
    enroll_port = port()
    server["extra"] = ["--cloud-listen", "127.0.0.1:" + str(enroll_port), "--cloud-root", str(ROOT / "server-data"), "--cloud-cert", str(ROOT / "tls.pem"), "--cloud-key", str(ROOT / "tls.key"), "--cloud-sync-port", str(server["sync"])]
    for user, password in [("alice", ALICE_PASSWORD), ("bob", BOB_PASSWORD)]:
        run(["--home", str(server["home"]), "cloud", "add-user", user], password)
    for node in (server, a, b, outsider):
        start(node)
    wait_for(lambda: "Cloud account enrollment listening" in (server["home"] / "e2e.log").read_text(), "account listener readiness")
    try:
        request(a, "cloud/join", {"server": "127.0.0.1:" + str(enroll_port), "username": "alice", "password": "wrong"})
        raise AssertionError("wrong password accepted")
    except urllib.error.HTTPError as e:
        assert e.code == 400
    assert not request(a, "config/folders"), "wrong password changed client config"
    try:
        request(a, "cloud/join", {}, key=False)
        raise AssertionError("unauthenticated join accepted")
    except urllib.error.HTTPError as e:
        assert e.code == 403
    paths = [Path(join(node, user, password)) for node, user, password in [(a, "alice", ALICE_PASSWORD), (b, "alice", ALICE_PASSWORD), (outsider, "bob", BOB_PASSWORD)]]
    assert Path(join(a, "alice", ALICE_PASSWORD)) == paths[0]
    assert len(request(a, "config/folders")) == 1
    try:
        join(a, "bob", BOB_PASSWORD)
        raise AssertionError("device joined a different account")
    except urllib.error.HTTPError as e:
        assert e.code == 400
    server_folders = request(server, "config/folders")
    assert len(server_folders) == 2
    alice_folder = next(f for f in server_folders if f["label"] == "XunCloud - alice")
    bob_folder = next(f for f in server_folders if f["label"] == "XunCloud - bob")
    assert len(alice_folder["devices"]) == 3 and len(bob_folder["devices"]) == 2
    assert Path(alice_folder["path"]).name == "user-alice"
    assert Path(bob_folder["path"]).name == "user-bob"
    for node in (a, b, outsider):
        wait_for(lambda node=node: any(c.get("connected") for c in request(node, "system/connections")["connections"].values()), "BEP connection")
    content = "account-scoped sync " + secrets.token_hex(16)
    (paths[0] / "hello.txt").write_text(content)
    request(a, "db/scan?folder=" + alice_folder["id"], {})
    wait_for(lambda: (paths[1] / "hello.txt").read_text() == content, "alice1 -> server -> alice2 transfer")
    assert (Path(alice_folder["path"]) / "hello.txt").read_text() == content
    assert not (paths[2] / "hello.txt").exists()
    assert not (Path(bob_folder["path"]) / "hello.txt").exists()
    (paths[1] / "reply.txt").write_text("reply-from-second-device")
    request(b, "db/scan?folder=" + alice_folder["id"], {})
    wait_for(lambda: (paths[0] / "reply.txt").read_text() == "reply-from-second-device", "alice2 -> server -> alice1 transfer")
    (paths[2] / "bob.txt").write_text("bob-private")
    request(outsider, "db/scan?folder=" + bob_folder["id"], {})
    wait_for(lambda: (Path(bob_folder["path"]) / "bob.txt").read_text() == "bob-private", "bob -> server transfer")
    assert not (paths[0] / "bob.txt").exists() and not (paths[1] / "bob.txt").exists()
    stop(server)
    start(server)
    wait_for(lambda: "Cloud account enrollment listening" in (server["home"] / "e2e.log").read_text(), "restarted enrollment")
    assert Path(join(a, "alice", ALICE_PASSWORD)) == paths[0]
    assert len(request(server, "config/folders")) == 2
    print("PASS: password auth, local API protection, repeat login, cross-account device rejection, two-way hub transfer, tenant isolation, server restart/persistence", flush=True)
finally:
    for p in processes:
        if p.poll() is None:
            p.terminate()
    for p in processes:
        try:
            p.wait(timeout=20)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
    for log in logs:
        log.close()
