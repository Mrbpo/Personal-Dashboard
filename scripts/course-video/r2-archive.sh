#!/usr/bin/env bash
# Existing server-only credentials; no new account, service, scheduler or public URL.
set -euo pipefail
umask 077
source /srv/study/backup-s3.env
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN S3_BUCKET S3_ENDPOINT
exec python3 /srv/study-course-video-tool/r2-archive.py "$@"
