#!/usr/bin/env bash
# Administrator-triggered run only. No scheduler or secret-bearing arguments.
set -euo pipefail
umask 077
tool_root=/srv/study-course-video-tool
archive_root=/srv/study-course-recordings
state_root=/srv/study-course-video-state
image=${COURSE_VIDEO_IMAGE:-study-course-video:interactive1.63.0}
course_id=440904
tool_id=8084
channel_id=814427
kaf_host=kaltura-quercus-prod.utoronto.ca
asset_url=https://assets.cap2.mediaspace.kaltura.com/5.188.26.1331/public/build0/js/kmsCookie.js
download=0
entry_id=
limit=0
tool_supplied=0
channel_supplied=0
discover=0
usage() {
  echo 'Usage: server-run.sh [--discover-channels | --download] [--entry-id ID] [--limit N] [--course-id N --tool-id N --channel-id N] [--kaf-host HOST] [--observed-asset-url URL]'
  echo 'Default is metadata only. Use --download for missing/updated verified recordings.'
}
while (( $# )); do
  case "$1" in
    --download) download=1; shift ;;
    --discover-channels) discover=1; shift ;;
    --course-id) course_id=${2:?}; shift 2 ;;
    --tool-id) tool_id=${2:?}; tool_supplied=1; shift 2 ;;
    --channel-id) channel_id=${2:?}; channel_supplied=1; shift 2 ;;
    --kaf-host) kaf_host=${2:?}; shift 2 ;;
    --observed-asset-url) asset_url=${2:?}; shift 2 ;;
    --entry-id) entry_id=${2:?}; shift 2 ;;
    --limit) limit=${2:?}; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo 'Unknown option.' >&2; usage >&2; exit 2 ;;
  esac
done
[[ $course_id =~ ^[1-9][0-9]*$ && $tool_id =~ ^[1-9][0-9]*$ && $channel_id =~ ^[1-9][0-9]*$ && $limit =~ ^[0-9]+$ ]] ||
  { echo 'Identifiers must be positive integers; limit must be nonnegative.' >&2; exit 2; }
[[ $kaf_host =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'Invalid observed KAF hostname.' >&2; exit 2; }
[[ -z $entry_id || $entry_id =~ ^[01]_[A-Za-z0-9]+$ ]] ||
  { echo 'Invalid observed entry ID.' >&2; exit 2; }
[[ $course_id == 440904 || $tool_supplied == 1 && ( $channel_supplied == 1 || $discover == 1 ) ]] ||
  { echo 'Another course requires its observed tool and channel IDs.' >&2; exit 2; }
[[ $discover == 0 || $download == 0 && -z $entry_id ]] ||
  { echo 'Channel discovery cannot download or select an entry.' >&2; exit 2; }
[[ -f "$tool_root/course-video-grant.mjs" && -f "$tool_root/archive.py" && -f "$tool_root/interactive-entrypoint.sh" ]] ||
  { echo 'Server grant producer and collector are required.' >&2; exit 2; }
mkdir -p "$archive_root" "$state_root"
chmod 700 "$state_root"
exec 9>"$state_root/manual-run.lock"
flock -n 9 || { echo 'A run already uses this dedicated browser.' >&2; exit 2; }
args=(--course-url "https://q.utoronto.ca/courses/$course_id/external_tools/$tool_id"
      --output /archive --media-host "$kaf_host" --profile /state/browser
      --interactive-server --launch-url-stdin --login-timeout 900 --target-only)
if (( discover )); then
  args+=(--discover-channels)
else
  args+=(--channel-id "$channel_id" --known-gallery-url "https://$kaf_host/channel/channelid/$channel_id")
  [[ -z $asset_url ]] || args+=(--verify-observed-asset-url "$asset_url")
fi
[[ -z $entry_id ]] || args+=(--entry-id "$entry_id")
(( download == 0 )) || args+=(--download --limit "$limit")
# The vault/token remains in the existing worker; fresh grant flows only on stdin.
docker exec -i -e COURSE_VIDEO_COURSE_ID="$course_id" -e COURSE_VIDEO_TOOL_ID="$tool_id" \
  -e COURSE_VIDEO_CANVAS_ORIGIN=https://q.utoronto.ca \
  study-worker-1 node --experimental-strip-types --input-type=module \
  < "$tool_root/course-video-grant.mjs" |
  docker run --rm -i --init --name "study-course-video-manual-$$" \
    --read-only --memory=1g --cpus=2 --shm-size=256m \
    --tmpfs /tmp:rw,nosuid,size=256m -e HOME=/tmp \
    -p 127.0.0.1:6080:6080 \
    -v "$archive_root:/archive" -v "$state_root:/state" \
    -v "$tool_root/archive.py:/tool/archive.py:ro" \
    -v "$tool_root/interactive-entrypoint.sh:/tool/interactive-entrypoint.sh:ro" \
    "$image" "${args[@]}"
