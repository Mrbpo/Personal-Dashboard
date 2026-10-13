#!/bin/sh
set -eu
umask 077
# This image is a one-run authorization window. Host publishing MUST use
# 127.0.0.1:6080:6080 and an SSH tunnel; never expose an unauthenticated VNC UI.
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 &
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
x11vnc -display :99 -rfbport 5900 -localhost -nopw -forever -shared >/dev/null 2>&1 &
vnc_pid=$!
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/dev/null 2>&1 &
web_pid=$!
echo '{"state":"temporary_authorization_window_ready","port":6080}'
# Explicit stdin inheritance is necessary for the background collector to read
# the private one-use grant from Docker's input pipe. It is never placed in argv.
python /tool/archive.py "$@" <&0 &
collector_pid=$!
set +e
wait "$collector_pid"
result=$?
set -e
exit "$result"
