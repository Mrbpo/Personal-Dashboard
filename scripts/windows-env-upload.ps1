param(
    [string]$Server = "165.245.239.53",
    [string]$User = "root"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root ".env"
$scp = Get-Command scp.exe -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
$ssh = Get-Command ssh.exe -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { throw "Local .env was not found." }

# Production-only identity, session, database and filesystem values are deliberately excluded.
$allowed = @(
    "CANVAS_BASE_URL", "CANVAS_TOKEN",
    "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_ADMIN_KEY",
    "DEEPSEEK_API_KEY", "XAI_API_KEY", "XAI_MANAGEMENT_KEY", "XAI_TEAM_ID",
    "OWNER_EMAIL", "OWNER_NAME", "DASHBOARD_API_TOKEN", "TIMEZONE",
    "AUTO_SYNC_ENABLED", "AUTO_SYNC_INTERVAL_MINUTES", "PIAZZA_SYNC_INTERVAL_MINUTES",
    "AI_MONTHLY_BUDGET", "AI_MODEL_RATES",
    "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REDIRECT_URI",
    "GITHUB_REPOSITORY", "GITHUB_ACTIONS_TOKEN",
    "CHATGPT_AUTO", "CHATGPT_MODEL",
    "GOOGLE_HEALTH_CLIENT_ID", "GOOGLE_HEALTH_CLIENT_SECRET", "GOOGLE_HEALTH_REDIRECT_URI"
)
$allowedSet = @{}; foreach ($key in $allowed) { $allowedSet[$key] = $true }
$selected = [ordered]@{}
foreach ($line in [IO.File]::ReadAllLines($envPath)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $separator = $trimmed.IndexOf("=")
    if ($separator -lt 1) { continue }
    $key = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1)
    if (-not $allowedSet.ContainsKey($key)) { continue }
    $plain = $value.Trim().Trim('"').Trim("'")
    if (-not $plain -or $plain -match '^(replace-with|your-|example|changeme)') { continue }
    $selected[$key] = "$key=$value"
}
if ($selected.Count -eq 0) { throw "No non-empty allowed settings were found in local .env." }

Write-Host "Personal Dashboard - Secure .env Upload" -ForegroundColor Cyan
Write-Host "Encrypted channel: SSH to $User@$Server"
Write-Host "The following setting names will be merged; values stay hidden:" -ForegroundColor Yellow
$selected.Keys | ForEach-Object { Write-Host "  $_" }
Write-Host "`nProtected server values will NOT be replaced: SITE_DOMAIN, APP_ORIGIN, OWNER_ACCESS_KEY, SESSION_SECRET, DATABASE_URL, filesystem paths, and production authentication mode."
$answer = Read-Host "Type UPLOAD_ENV to merge and restart web/worker; anything else cancels"
if ($answer -cne "UPLOAD_ENV") { Write-Host "Cancelled. Nothing was uploaded."; exit 0 }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("study-runtime-" + [Guid]::NewGuid().ToString("N") + ".env")
try {
    [IO.File]::WriteAllLines($temporary, [string[]]$selected.Values, (New-Object Text.UTF8Encoding($false)))
    & $scp $temporary "${User}@${Server}:/srv/study/runtime.env.incoming"
    if ($LASTEXITCODE -ne 0) { throw "Secure upload failed." }

    $remoteScript = @'
set -euo pipefail
runtime=/srv/study/runtime.env
incoming=/srv/study/runtime.env.incoming
previous=/srv/study/runtime.env.previous
test -s "$runtime"
test -s "$incoming"
chmod 600 "$incoming"
cp -p "$runtime" "$previous"
cleanup() { rm -f -- "$incoming"; }
trap cleanup EXIT
python3 - <<'PY'
from pathlib import Path
import os

runtime = Path('/srv/study/runtime.env')
incoming = Path('/srv/study/runtime.env.incoming')
allowed = {
    'CANVAS_BASE_URL', 'CANVAS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_ADMIN_KEY',
    'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'XAI_MANAGEMENT_KEY', 'XAI_TEAM_ID',
    'OWNER_EMAIL', 'OWNER_NAME', 'DASHBOARD_API_TOKEN', 'TIMEZONE',
    'AUTO_SYNC_ENABLED', 'AUTO_SYNC_INTERVAL_MINUTES', 'PIAZZA_SYNC_INTERVAL_MINUTES',
    'AI_MONTHLY_BUDGET', 'AI_MODEL_RATES', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET',
    'GMAIL_REDIRECT_URI', 'GITHUB_REPOSITORY', 'GITHUB_ACTIONS_TOKEN', 'CHATGPT_AUTO',
    'CHATGPT_MODEL', 'GOOGLE_HEALTH_CLIENT_ID', 'GOOGLE_HEALTH_CLIENT_SECRET',
    'GOOGLE_HEALTH_REDIRECT_URI'
}
locked = {'SITE_DOMAIN', 'APP_ORIGIN', 'OWNER_ACCESS_KEY', 'SESSION_SECRET'}

def parse(path):
    values = {}
    order = []
    for raw in path.read_text(encoding='utf-8-sig').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        if key not in values:
            order.append(key)
        values[key] = value
    return values, order

current, order = parse(runtime)
updates, _ = parse(incoming)
if not locked.issubset(current):
    raise SystemExit('required production secrets are missing')
for key, value in updates.items():
    if key in allowed:
        if key not in current:
            order.append(key)
        current[key] = value
current['LOCAL_DEV_BYPASS_AUTH'] = 'false'
if 'LOCAL_DEV_BYPASS_AUTH' not in order:
    order.append('LOCAL_DEV_BYPASS_AUTH')
temporary = runtime.with_suffix('.env.new')
temporary.write_text(''.join(f'{key}={current[key]}\n' for key in order), encoding='utf-8')
os.chmod(temporary, 0o600)
temporary.replace(runtime)
PY
chown root:root "$runtime"
chmod 600 "$runtime"
version=$(cat /srv/study/current-version)
[[ "$version" =~ ^[a-f0-9]{40}$ ]]
export APP_VERSION="$version"
compose=(docker compose -f /srv/study/compose.yml)
if ! "${compose[@]}" up -d --force-recreate web worker; then
  cp -p "$previous" "$runtime"
  "${compose[@]}" up -d --force-recreate web worker
  exit 1
fi
healthy=0
for attempt in $(seq 1 30); do
  services=$("${compose[@]}" ps --status running --services)
  if curl -fsS http://127.0.0.1:3000/api/health/live >/dev/null \
     && grep -qx web <<<"$services" \
     && grep -qx worker <<<"$services"; then
    healthy=1
    break
  fi
  sleep 2
done
if test "$healthy" != 1; then
  cp -p "$previous" "$runtime"
  "${compose[@]}" up -d --force-recreate web worker
  exit 1
fi
echo runtime_env_merge=complete
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
    & $ssh "${User}@${Server}" "printf '%s' '$encoded' | base64 -d | bash"
    if ($LASTEXITCODE -ne 0) { throw "The server rejected the new configuration and restored the previous runtime.env." }
    Write-Host "`nEnvironment settings merged securely; web and worker are healthy." -ForegroundColor Green
}
finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
