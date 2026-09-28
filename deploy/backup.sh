#!/usr/bin/env bash
set -euo pipefail
# The caller stops web and worker before this consistent SQLite/blob snapshot.
test -s /srv/study/backup.recipient
test -s /srv/study/backup-s3.env
test -s /srv/study/kernel-postgres-password
test -d /srv/study/data
test -d /srv/study/assets
source /srv/study/backup-s3.env
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
: "${S3_BUCKET:?S3_BUCKET required}"
: "${S3_ENDPOINT:?S3_ENDPOINT required}"
[[ "$S3_ENDPOINT" == https://* ]]
[[ "$S3_BUCKET" =~ ^[a-zA-Z0-9._-]+$ ]]
command -v aws >/dev/null
command -v age >/dev/null
install -d -m 700 /srv/study/backups
temporary=$(mktemp -d /srv/study/backups/stage.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
umask 077
compose=(docker compose -f /srv/study/compose.yml)
"${compose[@]}" exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/kernel_postgres_password)" exec pg_dump -U study_kernel -d study_kernel -Fc --no-owner' > "$temporary/kernel.dump"
test -s "$temporary/kernel.dump"
(
  cd /srv/study
  find data assets -type f -print0 | sort -z | xargs -0 -r sha256sum
  sha256sum runtime.env Caddyfile compose.yml kernel-postgres-password backup-s3.env backup.recipient
) > "$temporary/manifest.sha256"
(cd "$temporary" && sha256sum kernel.dump) >> "$temporary/manifest.sha256"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
name="study-v1-$stamp.tar.age"
target="/srv/study/backups/$name"
tar -C /srv/study -cf - data assets runtime.env Caddyfile compose.yml kernel-postgres-password backup-s3.env backup.recipient -C "$temporary" kernel.dump manifest.sha256 \
  | age -R /srv/study/backup.recipient -o "$target.partial"
mv -- "$target.partial" "$target"
chmod 600 "$target"
sha256sum "$target" > "$target.sha256"
prefix="${S3_PREFIX:-study-backups}"
key="${prefix%/}/$name"
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "$target" "s3://$S3_BUCKET/$key"
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "$target.sha256" "s3://$S3_BUCKET/$key.sha256"
aws --endpoint-url "$S3_ENDPOINT" s3api head-object --bucket "$S3_BUCKET" --key "$key" >/dev/null
printf '{"status":"uploaded","object":"%s","at":"%s"}\n' "$key" "$(date -u +%FT%TZ)" > /srv/study/status/backup.json
find /srv/study/backups -maxdepth 1 -type f -name 'study-v1-*.tar.age*' -mtime +7 -delete
printf '%s\n' "$key"
