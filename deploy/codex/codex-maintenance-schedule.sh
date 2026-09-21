#!/usr/bin/env bash
set -euo pipefail

queue_root=/srv/study/data/codex-queue
incoming="$queue_root/incoming"
status_file="$queue_root/status.json"
mkdir -p "$incoming"

pending=$(find "$incoming" -maxdepth 1 -type f -name '*.json' | wc -l)
if (( pending == 0 )); then exit 0; fi

write_status() {
  local state=$1 scheduled=${2:-}
  STATUS_STATE="$state" STATUS_PENDING="$pending" STATUS_SCHEDULED="$scheduled" STATUS_FILE="$status_file" \
    node -e 'const fs=require("fs"); const out={state:process.env.STATUS_STATE,pending:Number(process.env.STATUS_PENDING),scheduledFor:process.env.STATUS_SCHEDULED||null,updatedAt:new Date().toISOString()}; fs.writeFileSync(process.env.STATUS_FILE+".tmp",JSON.stringify(out)); fs.renameSync(process.env.STATUS_FILE+".tmp",process.env.STATUS_FILE);'
  chmod 660 "$status_file"
  chown root:codexmaint "$status_file"
}

if systemctl is-active --quiet codex-maintenance-night.timer || systemctl is-active --quiet codex-maintenance-night.service; then
  current=$(node -e 'try{const x=require(process.argv[1]);process.stdout.write(x.scheduledFor||"")}catch{}' "$status_file")
  write_status scheduled "$current"
  exit 0
fi

export TZ=America/Toronto
now=$(date +%s)
target=$(date -d "$(date +%F) 23:30:00" +%s)
if (( target <= now )); then target=$((now + 60)); fi
delay=$((target - now))
scheduled=$(date -d "@$target" --iso-8601=seconds)
systemctl reset-failed codex-maintenance-night.service >/dev/null 2>&1 || true
systemd-run --quiet --collect --unit=codex-maintenance-night --on-active="${delay}s" --timer-property=AccuracySec=1min /usr/local/libexec/codex-maintenance-run
write_status scheduled "$scheduled"
