param([string]$Version)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. "$PSScriptRoot\windows-tools.ps1"
$tools = Initialize-DashboardTools

Write-Host "Personal Dashboard - Publish Release" -ForegroundColor Cyan
if (& $tools.Git status --porcelain) {
    throw "The working tree is not clean. Run 01-Upload-to-GitHub first, then publish."
}

if ($Version) {
    if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
        throw "Version must use X.Y.Z, for example 0.2.0."
    }
    & $tools.Npm version $Version --no-git-tag-version
    if ($LASTEXITCODE -ne 0) { throw "Updating the version failed." }
    Write-Host "Version files changed but are not committed. Upload them, then run this script again." -ForegroundColor Yellow
    exit 0
}

& $tools.Npm run release:publish
if ($LASTEXITCODE -ne 0) { throw "Release preflight failed." }
$answer = Read-Host "A formal release triggers production deployment. Type RELEASE only when the server and secrets are ready"
if ($answer -cne "RELEASE") { Write-Host "Cancelled. No release was created."; exit 0 }
& $tools.Npm run release:publish -- --apply
if ($LASTEXITCODE -ne 0) { throw "Release creation failed. Check GitHub before retrying." }
Write-Host "Release created. Check GitHub Actions and server deployment status." -ForegroundColor Green
