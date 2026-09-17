#!/usr/bin/env bash
set -euo pipefail
# Caller must pause web+worker for a consistent filesystem/database backup.
test -f /srv/study/backup.recipient
install -d -m 700 /srv/study/backups
target="/srv/study/backups/study-$(date -u +%Y%m%dT%H%M%SZ).tar.age"
umask 077
tar -C /srv/study -cf - data | age -R /srv/study/backup.recipient -o "$target.partial"
mv -- "$target.partial" "$target"
chmod 600 "$target"
# Exact backup directory and filename pattern only; never touches live data.
find /srv/study/backups -maxdepth 1 -type f -name 'study-*.tar.age' -mmin +10080 -delete
