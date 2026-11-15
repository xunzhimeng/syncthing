#requires -Version 5.1
# Run from the extracted handoff root. No system certificate changes.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Ca = Join-Path $Root 'trust\ca.pem'
$Expected = '168dc62859e2bab44c89bfc70c36a2f3d95ffa523c9483b80c9d5510a35889cf'
if ((Get-FileHash -Algorithm SHA256 $Ca).Hash.ToLowerInvariant() -ne $Expected) { throw 'CA fingerprint mismatch' }
$Resources = Join-Path $Root 'source\desktop\src-tauri\resources'
New-Item -ItemType Directory -Force -Path $Resources | Out-Null
Copy-Item (Join-Path $Root 'windows\syncthing.exe') (Join-Path $Resources 'syncthing.exe')
Copy-Item $Ca (Join-Path $Resources 'ca.pem')
Set-Content -Path (Join-Path $Resources 'server.txt') -Encoding ASCII -Value '192.168.0.104:18443'
Push-Location (Join-Path $Root 'source\desktop')
try {
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npm.cmd run test:web
    if ($LASTEXITCODE -ne 0) { throw 'web tests failed' }
    npm.cmd run tauri -- build
    if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed; check MSVC, WebView2 and Rust prerequisites' }
} finally { Pop-Location }
