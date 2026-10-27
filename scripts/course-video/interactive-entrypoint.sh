#!/bin/sh
set -eu
umask 077
# POSIX async commands replace fd 0 with /dev/null before their redirects. Save
# the original one-use grant pipe first; only the collector may inherit it.
exec 3<&0
# This image is a one-run authorization window. Use either a loopback SSH
# tunnel or the private Docker network behind the website owner-auth proxy.
# Never publish the unauthenticated VNC endpoint on a public host address.
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp 3<&- >/dev/null 2>&1 &
display_pid=$!
vnc_pid=
web_pid=
collector_pid=
cleanup() {
  if [ -n "$collector_pid" ]; then kill -INT "$collector_pid" 2>/dev/null || true; fi
  for task_pid in "$collector_pid" "$web_pid" "$vnc_pid" "$display_pid"; do
    if [ -n "$task_pid" ]; then kill "$task_pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT HUP INT TERM
attempt=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  attempt=$((attempt+1))
  if [ "$attempt" -ge 20 ]; then echo '{"state":"display_unavailable"}'; exit 2; fi
  sleep 0.5
done
if [ "${COURSE_VIDEO_UNATTENDED:-0}" = 1 ]; then
  # Reuse the ordinary headed browser/profile without starting a VNC endpoint.
  echo '{"state":"unattended_browser_started"}'
else
  x11vnc -display :99 -rfbport 5900 -localhost -nopw -forever -shared 3<&- >/dev/null 2>&1 &
  vnc_pid=$!
  websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 3<&- >/dev/null 2>&1 &
  web_pid=$!
  echo '{"state":"temporary_authorization_window_ready","port":6080}'
fi
# Restore the saved descriptor after the async shell's default fd 0 handling.
python /tool/archive.py "$@" <&3 3<&- &
exec 3<&-
collector_pid=$!
set +e
wait "$collector_pid"
result=$?
set -e
exit "$result"
