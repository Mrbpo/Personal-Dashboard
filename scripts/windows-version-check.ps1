param([string]$Current)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. "$PSScriptRoot\windows-tools.ps1"
$tools = Initialize-DashboardTools

Write-Host "Personal Dashboard - Check Release Version" -ForegroundColor Cyan
if ($Current) {
    & $tools.Npm run version:check -- --repo Mrbpo/Personal-Dashboard --current $Current
} else {
    & $tools.Npm run version:check -- --repo Mrbpo/Personal-Dashboard
}
if ($LASTEXITCODE -ne 0) { throw "Version check failed. Failure does not mean the app is up to date." }
