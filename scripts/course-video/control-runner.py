#!/usr/bin/env python3
"""Root-host bridge for a fixed daily/manual action. No HTTP service or web Docker socket."""
import argparse
import json
import os
import re
import signal
import stat
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

AUTH_STATES = {'needs_reauth', 'needs_browser_verification', 'server_launch_rejected',
               'needs_asset_browser_verification'}


def now():
    return datetime.now(timezone.utc).isoformat()


def validated_request(value, clock=None):
    if not isinstance(value, dict) or set(value) != {'id', 'action', 'requestedAt'}:
        raise ValueError('INVALID_CONTROL_REQUEST')
    if not isinstance(value['id'], str) or str(uuid.UUID(value['id'])) != value['id']:
        raise ValueError('INVALID_CONTROL_REQUEST')
    if value['action'] not in {'sync', 'reauthorize'}:
        raise ValueError('INVALID_CONTROL_REQUEST')
    stamp = datetime.fromisoformat(value['requestedAt'].replace('Z', '+00:00'))
    clock = clock or datetime.now(timezone.utc)
    if stamp.tzinfo is None or not clock - timedelta(days=1) <= stamp <= clock + timedelta(minutes=5):
        raise ValueError('STALE_CONTROL_REQUEST')
    return value


def classify_result(exit_code, events):
    if any(event.get('state') == 'grant_failed' and event.get('code') in
           {'CANVAS_HTTP_401', 'CANVAS_HTTP_403', 'CANVAS_TOKEN_NOT_CONFIGURED'} for event in events):
        return 'needs_auth', 'CANVAS_ACCESS_REQUIRED'
    if any(event.get('state') in AUTH_STATES for event in events):
        return 'needs_auth', 'AUTHORIZATION_REQUIRED'
    if exit_code == 0:
        return 'completed', 'SYNC_COMPLETED'
    return 'failed', 'SYNC_FAILED'


def publish(path, value, group):
    """Replace a root-owned status atomically; never follow a web-created temp symlink."""
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o640)
        if os.name == 'posix' and os.geteuid() == 0:
            os.chown(temporary, 0, group)
        temporary.replace(path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def claimed_request(root):
    """Claim first into a root-only parent, then inspect a bounded regular file."""
    private = root / 'private'
    private.mkdir(mode=0o700, exist_ok=True)
    claimed = private / ('request-' + str(uuid.uuid4()) + '.json')
    try:
        (root / 'requests' / 'request.json').replace(claimed)
    except FileNotFoundError:
        return None
    descriptor = os.open(claimed, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('INVALID_CONTROL_REQUEST')
        content = stream.read(2049)
    if len(content) > 2048:
        raise ValueError('INVALID_CONTROL_REQUEST')
    return validated_request(json.loads(content))


def subtitle_jobs(manifest, previous, subtitles=None, clock=None):
    """Durable notifications only; the subtitle worker, not this sync, claims/generates them."""
    jobs = {item['videoSha256']: item for item in previous.get('jobs', [])
            if isinstance(item, dict) and re.fullmatch(r'[a-f0-9]{64}', str(item.get('videoSha256', '')))}
    clock = clock or datetime.now(timezone.utc)
    for row in jobs.values():
        if row.get('state') == 'running':
            try:
                expiry = datetime.fromisoformat(row['leaseExpiresAt'].replace('Z', '+00:00'))
                active = expiry.tzinfo is not None and expiry > clock
            except (KeyError, ValueError, TypeError, AttributeError):
                active = False
            if not active:
                # A killed worker may have removed the trigger before finishing.
                # Keep its checkpoint and notBefore; the normal claim resumes it.
                row['state'] = 'pending'
    for entry in manifest.get('entries', {}).values():
        if entry.get('state') != 'archived':
            continue
        for file in entry.get('files', []):
            digest = file.get('sha256', '')
            remote = file.get('remote', {})
            if (file.get('kind') == 'video' and re.fullmatch(r'[a-f0-9]{64}', str(digest))
                    and remote.get('state') == 'verified' and remote.get('method') == 'full_get_sha256'
                    and remote.get('sha256') == digest and remote.get('bytes') == file.get('bytes')):
                row = jobs.setdefault(digest, {'id': digest, 'videoSha256': digest, 'courseId': entry['courseId'],
                                              'entryId': entry['entryId'], 'state': 'pending', 'createdAt': now()})
                bundle = read_json(subtitles / (digest + '.json'), {}) if subtitles is not None else {}
                bundle = bundle if isinstance(bundle, dict) else {}
                source, cues = bundle.get('source', {}), bundle.get('cues', [])
                source = source if isinstance(source, dict) else {}
                cues = cues if isinstance(cues, list) else []
                complete = (bundle.get('videoSha256') == digest and source.get('clipStartMs') == 0
                            and isinstance(entry.get('durationSeconds'), (int, float))
                            and isinstance(source.get('clipEndMs'), (int, float))
                            and source['clipEndMs'] >= entry['durationSeconds'] * 1000 - 1000
                            and bool(cues) and all(isinstance(c, dict) and isinstance(c.get('zh'), str) and c['zh'].strip() for c in cues))
                if complete:
                    row['state'] = 'completed'
                elif subtitles is not None and row.get('state') == 'completed':
                    row['state'] = 'pending'
    return {'schemaVersion': 1, 'jobs': list(jobs.values())}


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return default


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--action', choices=('sync', 'reauthorize'))
    parser.add_argument('--request', action='store_true')
    args = parser.parse_args()
    if bool(args.action) == args.request:
        parser.error('Choose one fixed action or --request')
    root = Path(os.environ.get('COURSE_VIDEO_CONTROL_DIR', '/srv/study-course-video-control'))
    tool = Path('/srv/study-course-video-tool')
    archive = Path('/srv/study-course-recordings')
    group = int(os.environ.get('COURSE_VIDEO_WEB_GID', '1000'))
    root.mkdir(mode=0o750, parents=True, exist_ok=True)
    request = None
    if args.request:
        try:
            request = claimed_request(root)
        except Exception:
            # Keep the current run/last success intact; the rejected claimed input
            # remains in private/ for administrator inspection.
            return 2
        if request is None:
            return 0
    action = request['action'] if request else args.action
    run_id = request['id'] if request else str(uuid.uuid4())
    import fcntl
    with (root / 'runner.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # Claimed duplicate request is acknowledged; current action keeps its status.
        prior = read_json(root / 'status.json', {})
        if action == 'sync' and not request and prior.get('state') == 'needs_auth':
            return 0  # Keep the homepage prompt; don't hammer the known-expired session daily.
        status = {'state': 'running', 'reasonCode': 'REAUTHORIZING' if action == 'reauthorize' else 'SYNC_RUNNING',
                  'updatedAt': now(), 'lastSuccessAt': prior.get('lastSuccessAt'), 'counts': {},
                  'authorizationActive': False, 'requestId': run_id, 'currentCourseId': None}
        publish(root / 'status.json', status, group)
        command = ['bash', str(tool / 'server-run.sh'), '--catalog', str(tool / 'core-courses.catalog.json'),
                   '--archive-r2', '--website-authorization' if action == 'reauthorize' else '--unattended']
        env = {**os.environ, 'COURSE_VIDEO_CONTROL_RUN_ID': run_id}
        events, child = [], None
        container = 'study-course-video-auth' if action == 'reauthorize' else 'study-course-video-daily'
        try:
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                     errors='replace', env=env, start_new_session=True)
            for line in child.stdout:
                if len(line) > 1024 * 1024:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                # Store only a fixed state, never URLs, tokens or provider exception text.
                event_state = event.get('state')
                if event_state in AUTH_STATES:
                    events.append({'state': event_state})
                if event_state == 'grant_failed' and event.get('code') in {'CANVAS_HTTP_401', 'CANVAS_HTTP_403', 'CANVAS_TOKEN_NOT_CONFIGURED'}:
                    events.append({'state': event_state, 'code': event['code']})
                if event_state == 'catalog_course_started':
                    status['currentCourseId'] = event.get('courseId') if re.fullmatch(r'[1-9][0-9]*', str(event.get('courseId', ''))) else None
                    status['authorizationActive'] = False
                if event_state == 'temporary_authorization_window_ready' and action == 'reauthorize':
                    status['authorizationActive'] = True
                if event_state == 'catalog_course_complete':
                    status['authorizationActive'] = False
                status['updatedAt'] = now()
                publish(root / 'status.json', status, group)
            exit_code = child.wait()
            status['state'], status['reasonCode'] = classify_result(exit_code, events)
            manifest = read_json(archive / 'manifest.json', {})
            subtitles = Path(os.environ.get('COURSE_VIDEO_SUBTITLE_DIR', '/srv/study/data/recording-subtitles'))
            # The subtitle worker holds this lock only while claiming/updating,
            # not during ASR or translation. Never overwrite its current lease.
            with (root / 'subtitle-queue.lock').open('a') as queue_lock:
                fcntl.flock(queue_lock, fcntl.LOCK_EX)
                queue = subtitle_jobs(manifest, read_json(root / 'subtitle-queue.json', {}), subtitles)
                publish(root / 'subtitle-queue.json', queue, group)
                if any(job.get('state') == 'pending' for job in queue['jobs']):
                    (root / 'subtitle-pending').touch(mode=0o600)
            status['counts'] = {'archivedVideos': sum(1 for e in manifest.get('entries', {}).values() for f in e.get('files', [])
                                                     if f.get('kind') == 'video' and f.get('remote', {}).get('state') == 'verified'),
                                'pendingSubtitles': sum(j.get('state') == 'pending' for j in queue['jobs'])}
            if status['state'] == 'completed':
                status['lastSuccessAt'] = now()
        except (Exception, KeyboardInterrupt):
            status.update(state='failed', reasonCode='RUNNER_STOPPED')
        finally:
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
            # Stop only a temporary container carrying this exact controller run label.
            inspected = subprocess.run(['docker', 'inspect', '--format', '{{index .Config.Labels "study.course-video.run"}}', container],
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False)
            if inspected.returncode == 0 and inspected.stdout.strip() == run_id:
                subprocess.run(['docker', 'stop', '--time', '20', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            status.update(updatedAt=now(), authorizationActive=False)
            publish(root / 'status.json', status, group)
        return 0 if status['state'] == 'completed' else 2


def stop_handler(*_):
    raise KeyboardInterrupt()


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, stop_handler)
    raise SystemExit(main())
