#!/usr/bin/env python3
"""Owner requests for fixed existing units and a small, read-only progress snapshot."""
import argparse
from collections import Counter
from datetime import datetime, timezone, timedelta
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import uuid

spec = importlib.util.spec_from_file_location('subtitle_worker', Path(__file__).with_name('subtitle-worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
TASKS = {
    'subtitles': ('course-subtitle-worker.service', None),
    'credentials': ('course-recording-credentials.service', 'course-recording-credentials.timer'),
    'backup': ('study-kernel-backup.service', 'study-kernel-backup.timer'),
    'status': ('study-background-status.service', 'study-background-status.timer'),
    'recordings': ('course-video-daily.service', 'course-video-daily.timer'),
}
ROOT = Path('/srv/study-course-video-control')
STATE = Path('/srv/study-course-asr-state/bilingual')
PUBLISHED = Path('/srv/study/data/recording-subtitles')


def now():
    return datetime.now(timezone.utc).isoformat()


def systemd(unit):
    result = subprocess.run(['systemctl', 'show', unit, '--no-pager', '--property=LoadState,ActiveState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,NextElapseUSecRealtime,LastTriggerUSec,UnitFileState,ExecStart'],
                            capture_output=True, text=True, timeout=10)
    values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    def timestamp(key):
        try:
            return datetime.strptime(values.get(key, ''), '%a %Y-%m-%d %H:%M:%S %Z').replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            return None
    concurrency = re.search(r'--workers ([12])\b', values.get('ExecStart', ''))
    return {'configured': values.get('LoadState') == 'loaded', 'workerLimit': int(concurrency[1]) if concurrency else 1,
            'running': values.get('ActiveState') in ('activating', 'active'),
            'result': values.get('Result'), 'exitCode': values.get('ExecMainStatus'),
            'enabled': values.get('UnitFileState') == 'enabled',
            'startedAt': timestamp('ExecMainStartTimestamp'), 'finishedAt': timestamp('ExecMainExitTimestamp'),
            'nextRunAt': timestamp('NextElapseUSecRealtime'), 'lastRunAt': timestamp('LastTriggerUSec')}


def coverage(intervals, duration):
    end = covered = 0
    for start, finish in sorted(intervals):
        start, finish = max(0, start), min(duration, finish)
        if finish > max(end, start):
            covered += finish - max(end, start)
        end = max(end, finish)
    return min(duration, covered)


def safe_input_recovery(job, state=STATE):
    """No paid request can precede its durable ledger. Never retry a ledger-bearing failure."""
    sha = job.get('videoSha256', '')
    if job.get('state') != 'failed' or job.get('reasonCode') not in ('SUBTITLE_INPUT_UNREADABLE', 'TRANSLATION_STOPPED_REVIEW_LEDGER') or not re.fullmatch('[a-f0-9]{64}', sha):
        return False
    workspaces = list((state / sha).glob('*'))
    if len(workspaces) != 1 or not re.fullmatch('[a-f0-9]{40}', workspaces[0].name):
        return False
    workspace = workspaces[0]
    if list(workspace.glob('translation-output/*ledger*')) or list(workspace.glob('translation-output/*.response-*.json')):
        return False
    source = workspace / 'translation-input/source.vtt'
    proof = worker.read_json(source.with_suffix('.vtt.provenance.json'), {})
    return (source.is_file() and proof.get('sourceVideoSha256') == sha and proof.get('clipStartMs') == 0 and
            proof.get('modelRevision') == workspace.name and type(proof.get('clipEndMs')) is int and proof['clipEndMs'] > 0 and
            proof.get('subtitleSha256') == worker.digest(source))


def recover_inputs(root=ROOT, state=STATE):
    with worker.queue_lock(root):
        queue = worker.read_json(root / 'subtitle-queue.json', {'jobs': []})
        selected = [row for row in queue['jobs'] if safe_input_recovery(row, state)]
        if selected:
            # Preserve the entire old rows and attempts; no billed ledger is changed or removed.
            worker.atomic(root / 'private' / ('subtitle-recovery-' + uuid.uuid4().hex + '.json'), {'at': now(), 'jobs': selected})
            for row in selected:
                row.update(state='pending', reasonCode='SUBTITLE_INPUT_RECOVERED', notBefore=None)
            queue['jobs'] = selected + [row for row in queue['jobs'] if row not in selected]
            worker.atomic(root / 'subtitle-queue.json', queue, 1000)
            (root / 'subtitle-pending').touch(mode=0o600)
    return len(selected)


def subtitle_progress(job, duration, state=STATE, published=PUBLISHED):
    sha = job.get('videoSha256', '')
    if not re.fullmatch('[a-f0-9]{64}', sha):
        raise ValueError('INVALID_SUBTITLE_JOB')
    intervals, chunks, total_cues, translated = [], 0, 0, 0
    workspaces = [p for p in (state / sha).glob('*') if p.is_dir() and re.fullmatch('[a-f0-9]{40}', p.name)]
    # A later parser/model version is a separate run, never a source of mixed coverage.
    revision = job.get('progress', {}).get('modelRevision')
    preferred = [p for p in workspaces if p.name == revision]
    workspaces = preferred or sorted(workspaces, key=lambda p: p.stat().st_mtime, reverse=True)[:1]
    for workspace in workspaces:
        for path in workspace.glob('chunk-*.vtt.provenance.json'):
            proof = worker.read_json(path, {})
            a, b = proof.get('clipStartMs'), proof.get('clipEndMs')
            if (proof.get('sourceVideoSha256') == sha and proof.get('modelRevision') == workspace.name and
                    path.with_name(path.name.removesuffix('.provenance.json')).is_file() and type(a) is int and type(b) is int and 0 <= a < b):
                intervals.append((a, b))
        source = workspace / 'translation-input/source.vtt'
        if source.is_file():
            total_cues = max(total_cues, source.read_text(encoding='utf-8-sig').count(' --> '))
        candidate = worker.read_json(workspace / 'translation-output' / (sha + '.json'), {})
        if candidate.get('videoSha256') == sha:
            cues = candidate.get('cues', [])
            total_cues = max(total_cues, len(cues))
            translated = max(translated, sum(bool(c.get('zh')) for c in cues))
    chunks = len(set(intervals))
    bundle = worker.read_json(published / (sha + '.json'), {})
    available = bundle.get('videoSha256') == sha and bool(bundle.get('cues'))
    if available:
        cues = bundle['cues']
        total_cues = max(total_cues, len(cues))
        translated = max(translated, sum(bool(c.get('zh')) for c in cues))
    source = bundle.get('source', {})
    full = available and source.get('clipStartMs') == 0 and abs(source.get('clipEndMs', 0) - duration) <= 1000
    complete = bool(full and bundle.get('translation') and all(c.get('zh') for c in bundle['cues']))
    progress = job.get('progress', {})
    state_name = 'completed' if complete else job.get('state', 'unknown')
    try:
        if state_name == 'pending' and job.get('notBefore') and datetime.fromisoformat(job['notBefore'].replace('Z', '+00:00')) > datetime.now(timezone.utc):
            state_name = 'deferred'
        if state_name == 'running' and datetime.fromisoformat(job['leaseExpiresAt'].replace('Z', '+00:00')) < datetime.now(timezone.utc):
            state_name = 'interrupted'
    except (ValueError, KeyError, TypeError, AttributeError):
        if state_name == 'running':
            state_name = 'interrupted'
    return {'videoSha256': sha, 'courseId': str(job.get('courseId', '')), 'state': state_name,
            'reasonCode': None if complete else job.get('reasonCode'), 'startedAt': job.get('startedAt'), 'updatedAt': progress.get('updatedAt') or job.get('updatedAt'),
            'retryAt': job.get('notBefore'), 'stage': progress.get('stage'), 'durationMs': duration,
            'englishCoveredMs': coverage(intervals, duration), 'completedChunks': chunks,
            'totalChunks': math.ceil(duration / 300000) if duration else 0,
            'translatedCues': translated, 'totalCues': total_cues,
            'published': bool(available), 'partial': bool(available and not full), 'complete': complete,
            'resumable': safe_input_recovery(job, state)}


def snapshot(root=ROOT, state=STATE, published=PUBLISHED):
    manifest = worker.read_json(Path('/srv/study-course-recordings/manifest.json'), {})
    durations = {}
    for entry in manifest.get('entries', {}).values():
        seconds = entry.get('durationSeconds')
        if not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 0 < seconds <= 21600:
            continue
        for file in entry.get('files', []):
            if file.get('kind') == 'video':
                durations[file.get('sha256')] = round(seconds * 1000)
    queue = worker.read_json(root / 'subtitle-queue.json', {'jobs': []})
    rows, unreadable = [], 0
    for job in queue['jobs']:
        try:
            rows.append(subtitle_progress(job, durations.get(job.get('videoSha256'), 0), state, published))
        except (ValueError, OSError, TypeError, AttributeError, KeyError):
            unreadable += 1
    services = {}
    for task, (unit, timer) in TASKS.items():
        value = systemd(unit)
        if timer:
            scheduled = systemd(timer)
            value.update(enabled=scheduled['enabled'], nextRunAt=scheduled['nextRunAt'], lastRunAt=scheduled['lastRunAt'])
        request = worker.read_json(root / ('task-result-' + task + '.json'), {})
        if request.get('accepted') is False and request.get('at', '') > (value.get('startedAt') or ''):
            value['result'] = 'start-failed'
        services[task] = value
    services['status']['running'] = False  # This snapshot is published immediately before its unit exits.
    services['subtitles']['enabled'] = systemd('course-subtitle-worker.path')['enabled']
    if not services['subtitles']['running']:
        for row in rows:
            if row['state'] == 'running':
                row['state'] = 'interrupted'
    capacity = worker.read_json(root / 'subtitle-capacity.json', {})
    result = {'schemaVersion': 1, 'updatedAt': now(), 'services': services,
              'parallel': {'configured': services['subtitles']['workerLimit'], 'admitted': capacity.get('admitted'),
                           'active': sum(row['state'] == 'running' for row in rows)},
              'subtitles': {'items': rows, 'total': len(queue['jobs']), 'unreadable': unreadable,
                            'states': dict(Counter(row['state'] for row in rows)),
                            'complete': sum(row['complete'] for row in rows),
                            'englishComplete': sum(row['durationMs'] > 0 and row['englishCoveredMs'] >= row['durationMs'] - 1000 for row in rows),
                            'published': sum(row['published'] for row in rows)}}
    result['subtitles']['resumable'] = sum(row['resumable'] for row in rows)
    worker.atomic(root / 'background-status.json', result, 1000)
    return result


def validate_request(value, clock=None):
    clock = clock or datetime.now(timezone.utc)
    if not isinstance(value, dict) or set(value) != {'id', 'task', 'requestedAt'}:
        raise ValueError('INVALID_TASK_REQUEST')
    if not isinstance(value['id'], str) or str(uuid.UUID(value['id'])) != value['id'] or not isinstance(value['task'], str) or value['task'] not in TASKS or value['task'] == 'recordings' or not isinstance(value['requestedAt'], str):
        raise ValueError('INVALID_TASK_REQUEST')
    stamp = datetime.fromisoformat(value['requestedAt'].replace('Z', '+00:00'))
    if stamp.tzinfo is None or not clock - timedelta(minutes=10) <= stamp <= clock + timedelta(minutes=1):
        raise ValueError('STALE_TASK_REQUEST')
    return value


def run_request(root=ROOT):
    request_path = root / 'requests/maintenance-request.json'
    private = root / 'private'
    private.mkdir(exist_ok=True, mode=0o700)
    claimed = private / ('maintenance-' + uuid.uuid4().hex + '.json')
    try:
        request_path.replace(claimed)
    except FileNotFoundError:
        return
    descriptor = os.open(claimed, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, 1000):
            raise ValueError('INVALID_TASK_REQUEST')
        content = stream.read(513)
    if len(content) > 512:
        raise ValueError('INVALID_TASK_REQUEST')
    value = validate_request(json.loads(content))
    unit = TASKS[value['task']][0]
    if value['task'] == 'subtitles':
        recover_inputs(root)
    # systemd coalesces starts of an already-running oneshot; no arbitrary unit/arguments.
    result = subprocess.run(['systemctl', 'start', '--no-block', unit], capture_output=True, timeout=10)
    worker.atomic(root / ('task-result-' + value['task'] + '.json'),
                  {'requestId': value['id'], 'at': now(), 'accepted': result.returncode == 0}, 1000)
    snapshot(root)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', action='store_true')
    args = parser.parse_args()
    if args.request:
        run_request()
    else:
        snapshot()
