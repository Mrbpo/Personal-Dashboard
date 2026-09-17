param(
    [string]$Server = "165.245.239.53",
    [string]$User = "root"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$scp = (Get-Command scp.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
$ssh = (Get-Command ssh.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
if (-not $scp -or -not $ssh) {
    throw "Windows OpenSSH was not found. Enable OpenSSH Client in Windows Optional Features."
}

$deployFiles = @(
    "Caddyfile",
    "compose.yml",
    "receive.sh",
    "backup.sh",
    "daily-backup.sh",
    "verify-backup.sh",
    "study-backup.service",
    "study-backup.timer"
)

foreach ($name in $deployFiles) {
    $path = Join-Path $root "deploy\$name"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing deployment file: $path"
    }
}

$assetSource = Join-Path $root "public\assets\vic3-theme"
$assetFiles = @(Get-ChildItem -LiteralPath $assetSource -File)
if ($assetFiles.Count -eq 0) { throw "No Victorian assets were found." }

Write-Host "Personal Dashboard - Server Configuration Upload" -ForegroundColor Cyan
Write-Host "Server: $User@$Server"
Write-Host "Deployment files: $($deployFiles.Count)"
Write-Host "Private visual assets: $($assetFiles.Count)"
Write-Host "This does not upload runtime.env, OAuth tokens, databases, or backup keys." -ForegroundColor Yellow

$answer = Read-Host "Type UPLOAD to continue; anything else cancels"
if ($answer -cne "UPLOAD") {
    Write-Host "Cancelled. Nothing was uploaded."
    exit 0
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("study-server-upload-" + [Guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    $stageAssets = Join-Path $stage "assets"
    New-Item -ItemType Directory -Path $stageAssets | Out-Null

    foreach ($name in $deployFiles) {
        Copy-Item -LiteralPath (Join-Path $root "deploy\$name") -Destination (Join-Path $stage $name)
    }
    foreach ($asset in $assetFiles) {
        Copy-Item -LiteralPath $asset.FullName -Destination (Join-Path $stageAssets $asset.Name)
    }

    $sources = @(Get-ChildItem -LiteralPath $stage | ForEach-Object { $_.FullName })
    Write-Host "`nUploading. Enter your SSH key passphrase when Windows asks for it..." -ForegroundColor Cyan
    & $scp -r @sources "${User}@${Server}:/srv/study/"
    if ($LASTEXITCODE -ne 0) { throw "Upload failed." }

    Write-Host "`nApplying safe ownership and permissions..." -ForegroundColor Cyan
    $remoteCommand = "chown root:root /srv/study/Caddyfile /srv/study/compose.yml /srv/study/*.sh /srv/study/study-backup.* && chmod 644 /srv/study/Caddyfile /srv/study/compose.yml /srv/study/study-backup.* && chmod 700 /srv/study/*.sh && find /srv/study/assets -type d -exec chmod 755 {} + && find /srv/study/assets -type f -exec chmod 644 {} + && printf 'deployment_files=' && find /srv/study -maxdepth 1 -type f | wc -l && printf 'assets=' && find /srv/study/assets -type f | wc -l"
    & $ssh "${User}@${Server}" $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw "Files uploaded, but the permission check failed." }

    Write-Host "`nServer configuration and visual assets uploaded successfully." -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
