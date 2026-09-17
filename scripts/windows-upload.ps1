param(
    [string]$Message = "Update Personal Dashboard",
    [switch]$Apply
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. "$PSScriptRoot\windows-tools.ps1"
$tools = Initialize-DashboardTools

Write-Host "Personal Dashboard - GitHub Upload" -ForegroundColor Cyan
Write-Host "Target: Mrbpo/Personal-Dashboard (must be private)"
& $tools.Gh auth status
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not signed in. Run gh auth login first." }

Write-Host "`nUncommitted changes:" -ForegroundColor Yellow
& $tools.Git status --short
if ($LASTEXITCODE -ne 0) { throw "Unable to read Git status." }

if (-not $Apply) {
    $answer = Read-Host "After reviewing code and PNG files, type STAGE; anything else cancels"
    if ($answer -cne "STAGE") { Write-Host "Cancelled. Nothing was staged or uploaded."; exit 0 }
}

& $tools.Git add -A
if ($LASTEXITCODE -ne 0) { throw "Staging failed." }

& $tools.Npm run git:upload
if ($LASTEXITCODE -ne 0) { throw "Safety check failed. Files are staged but were not uploaded." }

if (-not $Apply) {
    $answer = Read-Host "Checks passed. Type UPLOAD to commit and upload; anything else cancels"
    if ($answer -cne "UPLOAD") { Write-Host "Upload cancelled. Staged files remain staged."; exit 0 }
}

& $tools.Npm run git:upload -- --apply --message $Message
if ($LASTEXITCODE -ne 0) { throw "Upload failed. The script will not force-push or replace remote history." }
Write-Host "Upload complete. A normal push does not deploy production." -ForegroundColor Green
