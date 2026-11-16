#!/usr/bin/env python3
"""Prepare public resources and package native Tauri CI builds; never read a user profile."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import ssl
import subprocess
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
CA_SHA256 = '168dc62859e2bab44c89bfc70c36a2f3d95ffa523c9483b80c9d5510a35889cf'


def public_ca():
    pem = (ROOT / 'desktop/trust/lan-ca.pem').read_bytes()
    if b'PRIVATE KEY' in pem or pem.count(b'BEGIN CERTIFICATE') != 1:
        raise ValueError('Only the public LAN CA certificate may be bundled')
    if hashlib.sha256(pem).hexdigest() != CA_SHA256:
        raise ValueError('LAN CA fingerprint mismatch')
    ssl.PEM_cert_to_DER_cert(pem.decode('ascii'))
    return pem


def server_address(value):
    value = value.strip()
    if not value or len(value) > 512 or any(c.isspace() for c in value):
        raise ValueError('Invalid enrollment server address')
    parsed = urlsplit(value if value.startswith('https://') else 'https://' + value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('Use an HTTPS host[:port], without credentials, paths or query strings')
    _ = parsed.port  # Also reject malformed ports.
    return 'https://' + parsed.netloc


def prepare(server):
    resources = ROOT / 'desktop/src-tauri/resources'
    resources.mkdir(parents=True, exist_ok=True)
    (resources / 'ca.pem').write_bytes(public_ca())
    (resources / 'server.txt').write_text(server_address(server) + '\n', encoding='utf-8')
    print('Prepared public CA and enrollment address; no runtime credentials')


def package(target, output):
    target = target.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError('Artifact output must be empty')
    version = json.loads((ROOT / 'desktop/package.json').read_text())['version']
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    os_name = {'Darwin': 'macos', 'Windows': 'windows'}.get(platform.system())
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'AMD64': 'x64'}.get(platform.machine())
    if not os_name or not arch:
        raise ValueError('Packaging is supported on native macOS and Windows runners')
    basename = f'XunCloud-{version}-{os_name}-{arch}-{commit[:8]}'
    if os_name == 'macos':
        app = target / 'release/bundle/macos/小寻云同步.app'
        if not app.is_dir():
            raise ValueError('Tauri .app bundle is missing')
        subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(app)], check=True)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        artifact = output / (basename + '.zip')
        subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(artifact)], check=True)
    else:
        installers = list((target / 'release/bundle/nsis').glob('*.exe'))
        if len(installers) != 1:
            raise ValueError(f'Expected exactly one NSIS installer, found {len(installers)}')
        artifact = output / (basename + '-setup.exe')
        shutil.copy2(installers[0], artifact)
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    (output / 'SHA256SUMS.txt').write_text(digest + '  ' + artifact.name + '\n', encoding='utf-8')
    metadata = {'version': version, 'commit': commit, 'platform': os_name, 'arch': arch,
                'caFileSHA256': CA_SHA256, 'artifact': artifact.name, 'sha256': digest,
                'signedForDistribution': False, 'runURL': os.environ.get('GITHUB_SERVER_URL', 'https://github.com') + '/' + os.environ.get('GITHUB_REPOSITORY', 'xunzhimeng/syncthing') + '/actions/runs/' + os.environ.get('GITHUB_RUN_ID', '')}
    (output / 'build-info.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(f'### {os_name} / {arch}\n\nDownload **{artifact.name}** from this run\'s Artifacts.\n\n')
            f.write('Local/ad-hoc test build; not Apple-notarized or Windows Authenticode signed.\n\n')
            f.write(f'Commit: `{commit}`\n\nSHA-256: `{digest}`\n')
    print(json.dumps(metadata, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    stage = sub.add_parser('prepare')
    stage.add_argument('--server', default='192.168.0.104:18443')
    build = sub.add_parser('package')
    build.add_argument('--target-dir', type=Path, required=True)
    build.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.server)
    else:
        package(args.target_dir, args.output)


if __name__ == '__main__':
    main()
