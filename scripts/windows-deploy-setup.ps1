param(
    [string]$Server = "165.245.239.53",
    [string]$Repository = "Mrbpo/Personal-Dashboard"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. "$PSScriptRoot\windows-tools.ps1"
$tools = Initialize-DashboardTools

$ssh = Get-Command ssh.exe -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
$sshKeygen = Get-Command ssh-keygen.exe -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
$keyPath = Join-Path $env:USERPROFILE ".ssh\personal_dashboard_github_deploy_ed25519"
$publicKeyPath = "$keyPath.pub"
$expectedFingerprint = "SHA256:Vk/3ZbxoI4aNswNKXyYwqeHD12lRIT2a7HpMS6ea5Ag"

Write-Host "Personal Dashboard - GitHub Automatic Deployment Setup" -ForegroundColor Cyan
Write-Host "Repository: $Repository"
Write-Host "Server: $Server"
Write-Host "A dedicated restricted key will be used. It cannot open a normal server shell." -ForegroundColor Yellow
$answer = Read-Host "Type CONFIGURE to continue; anything else cancels"
if ($answer -cne "CONFIGURE") { Write-Host "Cancelled. Nothing was changed."; exit 0 }

& $tools.Gh auth status
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not signed in." }
$visibility = & $tools.Gh repo view $Repository --json visibility --jq .visibility
if ($LASTEXITCODE -ne 0 -or $visibility.Trim() -ne "PRIVATE") {
    throw "The GitHub repository was not found or is not private."
}

if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $keyPath -Parent) | Out-Null
    $keyCommand = '"' + $sshKeygen + '" -q -t ed25519 -N "" -f "' + $keyPath + '" -C "github-actions-personal-dashboard"'
    & $env:ComSpec /d /s /c $keyCommand
    if ($LASTEXITCODE -ne 0) { throw "Unable to create the dedicated deployment key." }
}
if (-not (Test-Path -LiteralPath $publicKeyPath -PathType Leaf)) {
    $derived = & $sshKeygen -y -f $keyPath
    if ($LASTEXITCODE -ne 0) { throw "The deployment key is encrypted or unreadable." }
    Set-Content -LiteralPath $publicKeyPath -Value $derived -Encoding ascii
}
$publicKey = (Get-Content -Raw -LiteralPath $publicKeyPath).Trim()
if ($publicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$') { throw "Unexpected deployment public key format." }

$authorized = 'restrict,command="sudo -n /srv/study/receive.sh" ' + $publicKey
$encodedAuthorized = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($authorized + "`n"))
$setup = @"
set -euo pipefail
id -u studydeploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash studydeploy
usermod --shell /bin/bash studydeploy
passwd -l studydeploy >/dev/null 2>&1 || true
install -d -m 700 -o studydeploy -g studydeploy /home/studydeploy/.ssh
printf '%s' '$encodedAuthorized' | base64 -d > /home/studydeploy/.ssh/authorized_keys
chown studydeploy:studydeploy /home/studydeploy/.ssh/authorized_keys
chmod 600 /home/studydeploy/.ssh/authorized_keys
printf '%s\n' 'Defaults:studydeploy env_keep += "SSH_ORIGINAL_COMMAND"' 'studydeploy ALL=(root) NOPASSWD: /srv/study/receive.sh' > /etc/sudoers.d/studydeploy-dashboard
chmod 440 /etc/sudoers.d/studydeploy-dashboard
visudo -cf /etc/sudoers.d/studydeploy-dashboard
test "`$(stat -c %U /srv/study/receive.sh)" = root
test "`$(stat -c %a /srv/study/receive.sh)" = 700
echo 'Restricted deployment account configured.'
"@
$encodedSetup = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($setup))
Write-Host "`nConfiguring the restricted account. Enter your normal SSH key passphrase..." -ForegroundColor Cyan
& $ssh "root@$Server" "printf '%s' '$encodedSetup' | base64 -d | bash"
if ($LASTEXITCODE -ne 0) { throw "Server deployment account setup failed." }

$localKnownHosts = Join-Path $env:USERPROFILE ".ssh\known_hosts"
if (-not (Test-Path -LiteralPath $localKnownHosts -PathType Leaf)) {
    throw "Windows has no saved SSH host keys. Sign in to the server once, then retry."
}
$savedHostLines = @(& $sshKeygen -F $Server -f $localKnownHosts) |
    Where-Object { $_ -and -not $_.StartsWith("#") }
$ed25519Line = $savedHostLines | Where-Object { $_ -match '\s+ssh-ed25519\s+' } | Select-Object -First 1
if (-not $ed25519Line) { throw "The saved server ED25519 host key was not found." }
$knownHosts = $ed25519Line.Trim() + "`n"
$scanFile = Join-Path ([System.IO.Path]::GetTempPath()) ("study-known-hosts-" + [Guid]::NewGuid().ToString("N"))
try {
    Set-Content -LiteralPath $scanFile -Value $knownHosts -Encoding ascii -NoNewline
    $fingerprintLine = (& $sshKeygen -lf $scanFile) -join " "
    if ($LASTEXITCODE -ne 0 -or $fingerprintLine -notlike "*$expectedFingerprint*") {
        throw "Server fingerprint mismatch. Expected $expectedFingerprint. GitHub secrets were not changed."
    }

    Write-Host "Verified server fingerprint: $expectedFingerprint" -ForegroundColor Green
    & $tools.Gh secret set DEPLOY_HOST --repo $Repository --body $Server
    if ($LASTEXITCODE -ne 0) { throw "Unable to save DEPLOY_HOST." }
    & $tools.Gh secret set DEPLOY_USER --repo $Repository --body "studydeploy"
    if ($LASTEXITCODE -ne 0) { throw "Unable to save DEPLOY_USER." }
    Get-Content -Raw -LiteralPath $keyPath | & $tools.Gh secret set DEPLOY_SSH_KEY --repo $Repository
    if ($LASTEXITCODE -ne 0) { throw "Unable to save DEPLOY_SSH_KEY." }
    $knownHosts | & $tools.Gh secret set DEPLOY_KNOWN_HOSTS --repo $Repository
    if ($LASTEXITCODE -ne 0) { throw "Unable to save DEPLOY_KNOWN_HOSTS." }
}
finally {
    if (Test-Path -LiteralPath $scanFile) { Remove-Item -LiteralPath $scanFile -Force }
}

Write-Host "`nGitHub deployment secrets configured:" -ForegroundColor Green
& $tools.Gh secret list --repo $Repository | Select-String 'DEPLOY_'
Write-Host "Private deployment key remains only in Windows and GitHub Secrets. Do not share it."
