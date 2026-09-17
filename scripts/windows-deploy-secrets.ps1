param(
    [string]$Server = "165.245.239.53",
    [string]$Repository = "Mrbpo/Personal-Dashboard"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. "$PSScriptRoot\windows-tools.ps1"
$tools = Initialize-DashboardTools
$sshKeygen = Get-Command ssh-keygen.exe -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
$keyPath = Join-Path $env:USERPROFILE ".ssh\personal_dashboard_github_deploy_ed25519"
$localKnownHosts = Join-Path $env:USERPROFILE ".ssh\known_hosts"
$expectedFingerprint = "SHA256:Vk/3ZbxoI4aNswNKXyYwqeHD12lRIT2a7HpMS6ea5Ag"

Write-Host "Personal Dashboard - Finish GitHub Deployment Secrets" -ForegroundColor Cyan
Write-Host "Repository: $Repository"
Write-Host "This step does not connect to the server and will not ask for an SSH passphrase."
$answer = Read-Host "Type FINISH to continue; anything else cancels"
if ($answer -cne "FINISH") { Write-Host "Cancelled. Nothing was changed."; exit 0 }

if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw "Dedicated deployment key is missing." }
if (-not (Test-Path -LiteralPath $localKnownHosts -PathType Leaf)) { throw "Windows saved host keys are missing." }
& $tools.Gh auth status
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not signed in." }
$visibility = & $tools.Gh repo view $Repository --json visibility --jq .visibility
if ($LASTEXITCODE -ne 0 -or $visibility.Trim() -ne "PRIVATE") { throw "The repository is missing or is not private." }

$savedHostLines = @(& $sshKeygen -F $Server -f $localKnownHosts) |
    Where-Object { $_ -and -not $_.StartsWith("#") }
$ed25519Line = $savedHostLines | Where-Object { $_ -match '\s+ssh-ed25519\s+' } | Select-Object -First 1
if (-not $ed25519Line) { throw "The saved server ED25519 host key was not found." }

$scanFile = Join-Path ([System.IO.Path]::GetTempPath()) ("study-known-hosts-" + [Guid]::NewGuid().ToString("N"))
try {
    Set-Content -LiteralPath $scanFile -Value ($ed25519Line.Trim() + "`n") -Encoding ascii -NoNewline
    $fingerprintLine = (& $sshKeygen -lf $scanFile) -join " "
    if ($LASTEXITCODE -ne 0 -or $fingerprintLine -notlike "*$expectedFingerprint*") {
        throw "Server fingerprint mismatch. GitHub secrets were not changed."
    }
    Write-Host "Verified server fingerprint: $expectedFingerprint" -ForegroundColor Green

    & $tools.Gh secret set DEPLOY_HOST --repo $Repository --body $Server
    if ($LASTEXITCODE -ne 0) { throw "Unable to save DEPLOY_HOST." }
    & $tools.Gh secret set DEPLOY_USER --repo $Repository --body "studydeploy"
    if ($LASTEXITCODE -ne 0) { throw "Unable to save DEPLOY_USER." }
    Get-Content -Raw -LiteralPath $keyPath | & $tools.Gh secret set DEPLOY_SSH_KEY --repo $Repository
    if ($LASTEXITCODE -ne 0) { throw "Unable to save DEPLOY_SSH_KEY." }
    Get-Content -Raw -LiteralPath $scanFile | & $tools.Gh secret set DEPLOY_KNOWN_HOSTS --repo $Repository
    if ($LASTEXITCODE -ne 0) { throw "Unable to save DEPLOY_KNOWN_HOSTS." }
}
finally {
    if (Test-Path -LiteralPath $scanFile) { Remove-Item -LiteralPath $scanFile -Force }
}

Write-Host "`nGitHub deployment secrets configured:" -ForegroundColor Green
& $tools.Gh secret list --repo $Repository | Select-String 'DEPLOY_'
Write-Host "Secret values remain hidden."
