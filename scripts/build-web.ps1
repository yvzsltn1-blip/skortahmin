$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"

if (Test-Path $dist) {
  Remove-Item -LiteralPath $dist -Recurse -Force
}

New-Item -ItemType Directory -Path $dist | Out-Null
Copy-Item -LiteralPath (Join-Path $root "index.html") -Destination (Join-Path $dist "index.html") -Force

# Kupa müzesi görselleri (APK içine de kopyalanır)
$kupaSrc = Join-Path $root "kupa"
if (Test-Path $kupaSrc) {
  Copy-Item -LiteralPath $kupaSrc -Destination (Join-Path $dist "kupa") -Recurse -Force
}
