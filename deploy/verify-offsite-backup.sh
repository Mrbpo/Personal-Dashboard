#!/usr/bin/env bash
set -euo pipefail
umask 077

# The receiver passes the same archive to the local restore check first.
if test "$#" -lt 2 || test "$#" -gt 3; then exit 64; fi
archive=$1
key=$2
config=${3:-/srv/study/backup-s3.env}
name=${archive##*/}
[[ "$name" =~ ^study-v1-[0-9]{8}T[0-9]{6}Z\.tar\.age$ ]]
[[ "$archive" = /* && "$key" == */"$name" ]]
test -s "$archive"
test -s "$archive.sha256"
test -s "$config"
source "$config"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
: "${S3_BUCKET:?S3_BUCKET required}"
: "${S3_ENDPOINT:?S3_ENDPOINT required}"
[[ "$S3_ENDPOINT" == https://* ]]
[[ "$S3_BUCKET" =~ ^[a-zA-Z0-9._-]+$ ]]
command -v aws >/dev/null

# Verify the local sidecar before trusting it as the readback reference.
sha256sum -c --status "$archive.sha256"
read -r expected_hash expected_path < "$archive.sha256"
[[ "$expected_hash" =~ ^[a-f0-9]{64}$ && "$expected_path" == "$archive" ]]

temporary=$(mktemp -d "${archive%/*}/readback.XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "s3://$S3_BUCKET/$key.sha256" "$temporary/archive.sha256"
test -s "$temporary/archive.sha256"
cmp -s -- "$archive.sha256" "$temporary/archive.sha256"
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "s3://$S3_BUCKET/$key" "$temporary/archive"
test -s "$temporary/archive"
test "$(stat -c %s "$archive")" = "$(stat -c %s "$temporary/archive")"
download_hash=$(sha256sum "$temporary/archive")
test "${download_hash%% *}" = "$expected_hash"
cmp -s -- "$archive" "$temporary/archive"
