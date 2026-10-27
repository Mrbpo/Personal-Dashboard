#!/usr/bin/env python3
"""One bounded background subtitle job, using the existing archive, ASR and app budget."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

SHA = re.compile(r'^[a-f0-9]{64}$')
ENTRY = re.compile(r'^[01]_[A-Za-z0-9]+$')


def stamp():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except FileNotFoundError:
        return default


def atomic(path, value, group=None):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o640 if group is not None else 0o600)
        if group is not None and os.name == 'posix' and os.geteuid() == 0:
            os.chown(temporary, 0, group)
        temporary.replace(path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


@contextmanager
def queue_lock(root):
    import fcntl
    with (root / 'subtitle-queue.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def claim_job(queue, now=None):
    now = now or datetime.now(timezone.utc)
    for job in queue.get('jobs', []):
        if job.get('state') == 'running':
            try:
                expired = datetime.fromisoformat(job['leaseExpiresAt']) < now
            except (KeyError, ValueError):
                expired = True
            if expired:
                job['state'] = 'pending'
        if job.get('state') != 'pending':
            continue
        if job.get('notBefore'):
            try:
                if datetime.fromisoformat(job['notBefore']) > now:
                    continue
            except (TypeError, ValueError):
                job.update(state='failed', reasonCode='INVALID_SUBTITLE_JOB')
                continue
        if (not SHA.fullmatch(str(job.get('videoSha256', ''))) or
                not re.fullmatch(r'[1-9][0-9]*', str(job.get('courseId', ''))) or
                not ENTRY.fullmatch(str(job.get('entryId', '')))):
            job.update(state='failed', reasonCode='INVALID_SUBTITLE_JOB')
            continue
        job.update(state='running', leaseExpiresAt=(now + timedelta(minutes=40)).isoformat(),
                   startedAt=now.isoformat(), attempts=int(job.get('attempts', 0)) + 1)
        return dict(job)
    return None


def update_job(root, selected, state, reason, group, wake=True, not_before=None):
    with queue_lock(root):
        queue = read_json(root / 'subtitle-queue.json', {'schemaVersion': 1, 'jobs': []})
        for row in queue['jobs']:
            if row.get('videoSha256') == selected['videoSha256']:
                row.update(state=state, reasonCode=reason, updatedAt=stamp(), leaseExpiresAt=None)
                row['notBefore'] = not_before or (None if wake else (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat())
        atomic(root / 'subtitle-queue.json', queue, group)
        if wake and any(row.get('state') == 'pending' for row in queue['jobs']):
            (root / 'subtitle-pending').touch(mode=0o600)


def cached_chunk(vtt, video_sha, start_ms, end_ms, model):
    try:
        proof = read_json(vtt.with_suffix('.vtt.provenance.json'), {})
        return (vtt.is_file() and proof.get('sourceVideoSha256') == video_sha and
                proof.get('subtitleSha256') == digest(vtt) and proof.get('model') == model['repository'] and
                proof.get('modelRevision') == model['revision'] and proof.get('modelSha256') == model['sha256'] and
                proof.get('language') == 'en' and proof.get('computeType') == 'int8' and
                proof.get('timestampBasis') == 'clip-relative' and proof.get('clipStartMs') == start_ms and
                proof.get('clipEndMs') == end_ms and SHA.fullmatch(str(proof.get('sourceAudioSha256', ''))))
    except (OSError, ValueError):
        return False


def time_ms(value):
    match = re.fullmatch(r'(\d+):(\d{2}):(\d{2})\.(\d{3})', value)
    if not match or int(match[2]) > 59 or int(match[3]) > 59:
        raise ValueError('INVALID_CHUNK_TIMING')
    return ((int(match[1]) * 60 + int(match[2])) * 60 + int(match[3])) * 1000 + int(match[4])


def vtt_time(ms):
    return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}'


def merge_chunks(chunks, destination, duration_ms):
    lines = ['WEBVTT', '']
    count = 0
    previous = -1
    for path, offset, end in chunks:
        content = path.read_text(encoding='utf-8-sig').replace('\r\n', '\n')
        for block in content.split('\n\n'):
            rows = block.splitlines()
            timing = next((i for i, row in enumerate(rows) if ' --> ' in row), None)
            if timing is None:
                continue
            left, right = rows[timing].split(' --> ')
            start, finish = time_ms(left) + offset, time_ms(right) + offset
            if start < offset or finish > end or finish <= start or start < previous or finish > duration_ms:
                raise ValueError('INVALID_CHUNK_TIMING')
            previous = start
            lines.extend([f'{vtt_time(start)} --> {vtt_time(finish)}', *rows[timing + 1:], ''])
            count += 1
    if not count:
        raise ValueError('NO_SPEECH_DETECTED')
    destination.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return count


class TimeBound(Exception):
    pass


class ResourceBound(Exception):
    pass


class BudgetDeferred(Exception):
    def __init__(self, retry_at):
        super().__init__('SUBTITLE_BUDGET_DEFERRED')
        self.retry_at = retry_at


def budget_retry_at(ledger, expected_source_hash=None, now=None):
    """Only a proven, uncharged pre-request rejection is eligible for automatic deferral."""
    if not isinstance(ledger, dict) or not isinstance(ledger.get('calls'), list) or not ledger['calls']:
        return None
    if expected_source_hash is not None and ledger.get('sourceHash') != expected_source_hash:
        return None
    last = ledger['calls'][-1]
    if (not isinstance(last, dict) or last.get('state') != 'rejected' or
            type(last.get('charged')) not in (int, float) or last['charged'] != 0 or
            not isinstance(last.get('retryAt'), str)):
        return None
    try:
        retry = datetime.fromisoformat(last['retryAt'].replace('Z', '+00:00'))
        if retry.tzinfo is None or retry <= (now or datetime.now(timezone.utc)):
            return None
    except ValueError:
        return None
    return retry.isoformat()


def remaining(deadline, maximum):
    seconds = deadline - time.monotonic()
    if seconds < 15:
        raise TimeBound()
    return min(maximum, seconds)


def clean_env():
    return {key: value for key, value in os.environ.items() if not key.startswith(('AWS_', 'OPENAI_', 'S3_'))}


def command(args, deadline, maximum, env=None):
    try:
        result = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=remaining(deadline, maximum))
    except subprocess.TimeoutExpired as error:
        raise TimeBound() from error
    return result


def resource_reserve(path):
    available = next(int(row.split()[1]) * 1024 for row in Path('/proc/meminfo').read_text().splitlines()
                     if row.startswith('MemAvailable:'))
    if available < 3 * 1024**3 or shutil.disk_usage(path).free < 15 * 1024**3:
        raise ResourceBound()


def remove_derived_audio(work):
    """Only exact worker-created WAVs; keep every original, chunk text and provenance."""
    for path in [work / 'audio.wav', *work.glob('chunk-*.wav')]:
        if (path.name == 'audio.wav' or re.fullmatch(r'chunk-[0-9]+-[0-9]+\.wav', path.name)) and not path.is_symlink() and path.is_file():
            path.unlink()


def process_job(job, state, published, deadline):
    resource_reserve(state)
    tool = Path('/srv/study-course-video-tool')
    asr_tool = Path('/srv/study-course-asr-tool')
    model_path = Path('/srv/study-course-asr-state/models/faster-whisper-small.en')
    manifest = read_json(Path('/srv/study-course-recordings/manifest.json'))
    entry = next((row for row in manifest['entries'].values() if row.get('courseId') == job['courseId'] and
                  row.get('entryId') == job['entryId']), None)
    if entry is None:
        raise ValueError('SOURCE_VERSION_UNAVAILABLE')
    source = next((file for file in entry.get('files', []) if file.get('kind') == 'video' and
                   file.get('sha256') == job['videoSha256']), None)
    if source is None:
        raise ValueError('SOURCE_VERSION_UNAVAILABLE')
    seconds = entry.get('durationSeconds')
    if not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 0 < seconds <= 21600:
        raise ValueError('INVALID_SOURCE_DURATION')
    receipt = read_json(model_path / 'download-manifest.json')
    model_file = next(row for row in receipt['files'] if row['name'] == 'model.bin')
    model = {'repository': receipt['repository'], 'revision': receipt['revision'], 'sha256': model_file['sha256']}
    if not re.fullmatch('[a-f0-9]{40}', model['revision']) or not SHA.fullmatch(model['sha256']):
        raise ValueError('MODEL_PROOF_UNAVAILABLE')
    model_stat = (model_path / 'model.bin').stat()
    model_identity = {'sha256': model['sha256'], 'size': model_stat.st_size, 'mtimeNs': model_stat.st_mtime_ns}
    if read_json(state / 'model-proof.json', {}) != model_identity:
        if digest(model_path / 'model.bin') != model['sha256']:
            raise ValueError('MODEL_PROOF_UNAVAILABLE')
        atomic(state / 'model-proof.json', model_identity)
    # Same verified model artifact used by the existing ASR sample; never download a model here.
    work = state / job['videoSha256'] / model['revision']
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    spec = importlib.util.spec_from_file_location('recording_r2', tool / 'r2-archive.py')
    sys.path.insert(0, str(tool))
    r2 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(r2)
    store = r2.Store(os.environ['S3_ENDPOINT'], os.environ['S3_BUCKET'])
    remote = source.get('remote', {})
    if not r2.matches(remote, store.head(remote.get('key', '')), source, store, remote.get('key', '')):
        raise ValueError('SOURCE_REMOTE_PROOF_UNAVAILABLE')
    audio = work / 'audio.wav'
    proof = read_json(work / 'audio.json', {})
    valid_audio_proof = (proof.get('videoSha256') == job['videoSha256'] and SHA.fullmatch(str(proof.get('sha256', '')))
                         and isinstance(proof.get('durationMs'), int) and proof['durationMs'] > 0
                         and abs(proof['durationMs'] - seconds * 1000) <= 1000)
    all_chunks_cached = valid_audio_proof and all(
        cached_chunk(work / f'chunk-{start}-{min(proof["durationMs"], start + 300000)}.vtt',
                     job['videoSha256'], start, min(proof['durationMs'], start + 300000), model)
        for start in range(0, proof['durationMs'], 300000))
    if not all_chunks_cached and not (audio.is_file() and valid_audio_proof and proof['sha256'] == digest(audio)):
        url = subprocess.check_output(store.base + ['s3', 'presign', 's3://' + store.bucket + '/' + remote['key'],
                                                    '--expires-in', '3600'], stderr=subprocess.DEVNULL, text=True).strip()
        part = work / 'audio.part.wav'
        result = command(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', url, '-t', str(seconds),
                          '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(part)], deadline, 600)
        del url
        if result.returncode:
            raise ValueError('AUDIO_EXTRACTION_FAILED')
        part.replace(audio)
        probe = command(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(audio)], deadline, 30)
        if probe.returncode:
            raise ValueError('AUDIO_PROBE_FAILED')
        duration_ms = round(float(json.loads(probe.stdout)['format']['duration']) * 1000)
        if abs(duration_ms - seconds * 1000) > 1000:
            raise ValueError('AUDIO_DURATION_MISMATCH')
        proof = {'videoSha256': job['videoSha256'], 'sha256': digest(audio), 'durationMs': duration_ms}
        atomic(work / 'audio.json', proof)
    duration_ms = proof['durationMs']
    env = {**clean_env(), 'HF_HUB_OFFLINE': '1', 'OMP_NUM_THREADS': '2'}
    chunks = []
    for start in range(0, duration_ms, 300000):
        resource_reserve(state)
        end = min(duration_ms, start + 300000)
        vtt = work / f'chunk-{start}-{end}.vtt'
        if not cached_chunk(vtt, job['videoSha256'], start, end, model):
            sample = Path('/srv/study-course-asr-state/sample-600-900.vtt')
            if start == 600000 and end == 900000 and cached_chunk(sample, job['videoSha256'], start, end, model):
                shutil.copyfile(sample, vtt)
                shutil.copyfile(sample.with_suffix('.vtt.provenance.json'), vtt.with_suffix('.vtt.provenance.json'))
            else:
                clip = work / f'chunk-{start}-{end}.wav'
                result = command(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-ss', str(start / 1000), '-i', str(audio),
                                  '-t', str((end - start) / 1000), '-c:a', 'pcm_s16le', str(clip)], deadline, 60, env)
                if result.returncode:
                    raise ValueError('AUDIO_CHUNK_FAILED')
                result = command([str(asr_tool / 'venv/bin/python'), str(asr_tool / 'transcribe.py'), str(clip),
                                  '--model-path', str(model_path), '--source-video-sha256', job['videoSha256'],
                                  '--clip-start-ms', str(start), '--clip-end-ms', str(end), '--output', str(vtt),
                                  '--language', 'en', '--threads', '2'], deadline, 900, env)
                if result.returncode:
                    if b'No speech detected; original video remains preserved' not in result.stderr:
                        raise ValueError('ASR_CHUNK_FAILED')
                    vtt.write_text('WEBVTT\n\n', encoding='utf-8')
                    atomic(vtt.with_suffix('.vtt.provenance.json'), {'schemaVersion': 1, 'method': 'local-asr',
                           'model': model['repository'], 'modelRevision': model['revision'], 'modelSha256': model['sha256'],
                           'sourceVideoSha256': job['videoSha256'], 'sourceAudioSha256': digest(clip),
                           'subtitleSha256': digest(vtt), 'computeType': 'int8', 'language': 'en',
                           'clipStartMs': start, 'clipEndMs': end, 'timestampBasis': 'clip-relative', 'silence': True})
        chunks.append((vtt, start, end))
    inputs = work / 'translation-input'
    inputs.mkdir(exist_ok=True, mode=0o750)
    english = inputs / 'source.vtt'
    count = merge_chunks(chunks, english, duration_ms)
    provenance = {'schemaVersion': 1, 'method': 'local-asr', 'model': model['repository'],
                  'modelRevision': model['revision'], 'modelSha256': model['sha256'], 'computeType': 'int8',
                  'language': 'en', 'sourceVideoSha256': job['videoSha256'], 'sourceAudioSha256': proof['sha256'],
                  'subtitleSha256': digest(english), 'clipStartMs': 0, 'clipEndMs': duration_ms,
                  'timestampBasis': 'source-absolute', 'cues': count}
    atomic(english.with_suffix('.vtt.provenance.json'), provenance)
    output = work / 'translation-output'
    output.mkdir(exist_ok=True, mode=0o750)
    if os.geteuid() == 0:
        os.chown(inputs, 0, 1000)
        os.chown(output, 1000, 1000)
        for path in inputs.iterdir():
            os.chown(path, 0, 1000)
            path.chmod(0o640)
    image = os.environ.get('COURSE_VIDEO_APP_IMAGE')
    if not image:
        raise ValueError('SUBTITLE_APP_IMAGE_REQUIRED')
    base = ['docker', 'run', '--rm', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,size=32m',
            '--env-file', '/srv/study/runtime.env', '-e', 'NODE_ENV=production', '-e', 'CLOUD_MODE=true',
            '-e', 'DATABASE_URL=file:/app/data/course-radar-v2.db', '-e', 'SERVICE_VAULT_DIR=/app/data/private',
            '-v', '/srv/study/data:/app/data', '-v', str(inputs) + ':/input:ro', '-v', str(output) + ':/output', image,
            'node', '--experimental-strip-types', '/app/scripts/recording-subtitles.ts', '--input', '/input/source.vtt',
            '--provenance', '/input/source.vtt.provenance.json', '--output-dir', '/output', '--video-sha256', job['videoSha256'],
            '--source-method', 'local-asr', '--duration-seconds', str(seconds), '--budget-mode', 'runtime']
    for calls, usd in [('0', '0'), ('30', '1')]:
        container = 'study-subtitle-' + uuid.uuid4().hex
        command_args = base[:3] + ['--name', container] + base[3:] + ['--max-calls', calls, '--max-usd', usd]
        try:
            result = command(command_args, deadline, 600, clean_env())
        except TimeBound:
            # Only this invocation's generated container name; never stop the application's real worker.
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=20, env=clean_env())
            raise
        # Even if translation hits the normal budget, expose the complete English result.
        candidate = output / (job['videoSha256'] + '.json')
        if candidate.is_file():
            publish_bundle(candidate, published, job['videoSha256'])
            # Once the full English text/provenance is durable, raw derived WAVs
            # are rebuildable and would otherwise exhaust the small server disk.
            remove_derived_audio(work)
        if result.returncode:
            if b'SUBTITLE_RUNTIME_BUDGET_DEFERRED' in result.stderr:
                ledger = read_json(output / (job['videoSha256'] + '.translation-ledger.json'), {})
                retry_at = budget_retry_at(ledger, digest(english))
                if retry_at is not None:
                    raise BudgetDeferred(retry_at)
            raise ValueError('TRANSLATION_STOPPED_REVIEW_LEDGER')


def publish_bundle(candidate, published, video_sha):
    bundle = read_json(candidate)
    if bundle.get('videoSha256') != video_sha or not bundle.get('cues'):
        raise ValueError('GENERATED_BUNDLE_MISMATCH')
    published.mkdir(parents=True, exist_ok=True, mode=0o750)
    published.chmod(0o750)
    target = published / (video_sha + '.json')
    if target.is_file() and target.read_bytes() != candidate.read_bytes():
        history = published / 'history'
        history.mkdir(exist_ok=True, mode=0o700)
        old = history / (video_sha + '-' + digest(target) + '.json')
        if not old.exists():
            shutil.copyfile(target, old)
            old.chmod(0o600)
    atomic(target, bundle, 1000)
    if os.geteuid() == 0:
        os.chown(published, 0, 1000)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--max-seconds', type=int, default=1800)
    args = parser.parse_args()
    if not 60 <= args.max_seconds <= 1800:
        parser.error('max-seconds must be 60..1800')
    root = Path(os.environ.get('COURSE_VIDEO_CONTROL_DIR', '/srv/study-course-video-control'))
    state = Path('/srv/study-course-asr-state/bilingual')
    published = Path(os.environ.get('COURSE_VIDEO_SUBTITLE_DIR', '/srv/study/data/recording-subtitles'))
    if not root.is_dir():
        raise SystemExit('Install the host control directories first')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    import fcntl
    with (root / 'subtitle-worker.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        with queue_lock(root):
            queue = read_json(root / 'subtitle-queue.json', {'schemaVersion': 1, 'jobs': []})
            job = claim_job(queue)
            atomic(root / 'subtitle-queue.json', queue, 1000)
            (root / 'subtitle-pending').unlink(missing_ok=True)
        if job is None:
            return
        try:
            process_job(job, state, published, time.monotonic() + args.max_seconds)
            update_job(root, job, 'completed', 'SUBTITLES_COMPLETED', 1000)
        except TimeBound:
            update_job(root, job, 'pending', 'SUBTITLE_RESOURCE_BOUND', 1000)
        except ResourceBound:
            # Do not create a PathExists spin while memory/disk reserve remains low.
            # The next daily/manual sync wakes the queue after its notBefore time.
            update_job(root, job, 'pending', 'SUBTITLE_RESOURCE_RESERVE', 1000, wake=False)
        except BudgetDeferred as error:
            update_job(root, job, 'pending', 'SUBTITLE_BUDGET_DEFERRED', 1000,
                       wake=False, not_before=error.retry_at)
        except Exception as error:
            code = str(error) if re.fullmatch('[A-Z_]{3,80}', str(error)) else 'SUBTITLE_JOB_FAILED'
            update_job(root, job, 'failed', code, 1000)


if __name__ == '__main__':
    main()
