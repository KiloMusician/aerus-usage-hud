# Builds the standalone app folder and the Windows setup file.
#   packaging\stage  : published app (exe, bundled Node runtime, server, dashboard)
#   packaging\dist   : AerusAIUsageHUD-Setup-v<version>.exe
# Needs the .NET 9 SDK, Node.js (only to copy its runtime), and NSIS in build-tools\nsis (see README).
param([string]$Version = '1.0.1')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $root 'packaging\stage'
$dist = Join-Path $root 'packaging\dist'
$makensis = Join-Path $root 'build-tools\nsis\makensis.exe'

if (-not (Test-Path -LiteralPath $makensis)) { throw "NSIS not found at $makensis. See the README for where to put it." }
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source

Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
& dotnet publish (Join-Path $root 'desktop\AerusUsageHud.csproj') -c Release -r win-x64 --self-contained true -o $stage --verbosity minimal
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed.' }

foreach ($item in 'server.js', 'package.json', 'README.md', 'src', 'public', 'assets') {
    Copy-Item -LiteralPath (Join-Path $root $item) -Destination $stage -Recurse -Force
}

$runtime = Join-Path $stage 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $runtime 'node.exe') -Force
$nodeVersion = (& $nodeExe --version).Trim()
$nodeLicense = Get-ChildItem -LiteralPath (Split-Path $nodeExe) -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(LICENSE|COPYING)' } | Select-Object -First 1
if ($nodeLicense) { Copy-Item -LiteralPath $nodeLicense.FullName -Destination (Join-Path $runtime 'NODE-LICENSE.txt') -Force }
Set-Content -LiteralPath (Join-Path $runtime 'NODE-VERSION.txt') -Value "Bundled runtime: Node.js $nodeVersion`r`nSource: https://nodejs.org/" -Encoding utf8

if (-not (Test-Path -LiteralPath (Join-Path $stage 'Aerus AI Usage HUD.exe'))) { throw 'Published exe is missing.' }

# Release audit: no private usage data, snapshots, transcripts, debug symbols or personal paths may ship.
& node (Join-Path $root 'scripts\audit-package.mjs') $stage
if ($LASTEXITCODE -ne 0) { throw 'Release audit failed. The installer was not built.' }

New-Item -ItemType Directory -Path $dist -Force | Out-Null
& $makensis "/DSTAGE_DIR=$stage" "/DOUTPUT_DIR=$dist" "/DAPP_VERSION=$Version" (Join-Path $PSScriptRoot 'installer.nsi')
if ($LASTEXITCODE -ne 0) { throw 'NSIS build failed.' }

$setup = Join-Path $dist "AerusAIUsageHUD-Setup-v$Version.exe"
Write-Output "Built $setup ($([math]::Round((Get-Item $setup).Length / 1MB, 1)) MB) with Node.js $nodeVersion"
