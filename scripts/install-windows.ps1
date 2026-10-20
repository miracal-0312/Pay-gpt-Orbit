$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if ($args.Count -gt 0) { throw 'Usage: powershell -File scripts/install-windows.ps1 (Orbitcard API only)' }
node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 24 or newer is required' }
npm.cmd ci --omit=dev --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
if (!(Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
Write-Output 'Dependencies installed. Configure .env and MySQL, then run npm.cmd start.'
Write-Output 'Set the paired Orbitcard API Key and platform card ID in the administrator UI before enabling redemptions.'
