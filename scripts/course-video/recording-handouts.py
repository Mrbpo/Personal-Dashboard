#!/usr/bin/env python3
"""Publish lecture slide captures and their existing transcript. One lock per host."""
import argparse
import collections
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

HASH = re.compile(r'[0-9a-f]{64}')
REVISION = 'source-slides-v1'
FORMATS = {'html': ('guide.html', 32 << 20), 'pdf': ('guide.pdf', 64 << 20)}
PUBLISHED = Path('/srv/study/data/recording-guides')
SUBTITLES = Path('/srv/study/data/recording-subtitles')
STATE = Path('/var/lib/study-recording-handouts')


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def hash_bytes(data):
    return hashlib.sha256(data).hexdigest()


def write_atomic(path, data, public_cache=False):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as out:
        temp = Path(out.name)
        try:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    try:
        if public_cache and os.name == 'posix':
            os.chown(temp, -1, 1000)
            temp.chmod(0o640)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def choose_sources(manifest):
    families = collections.defaultdict(list)
    for entry in manifest['entries'].values():
        course = entry.get('courseId')
        if entry.get('state') != 'archived' or not re.fullmatch(r'[1-9][0-9]*', str(course)):
            continue
        own, parent = entry.get('entryId'), entry.get('parentEntryId') or entry.get('entryId')
        if not all(re.fullmatch(r'[01]_[A-Za-z0-9]+', str(key)) for key in (own, parent)):
            continue
        track = entry.get('track')
        if track == 'camera' or (track != 'screen' and own != parent):
            continue
        for item in entry.get('files', []):
            sha = str(item.get('sha256', ''))
            remote = item.get('remote') or {}
            if (item.get('kind') == 'video' and HASH.fullmatch(sha)
                    and remote.get('state') == 'verified' and remote.get('method') == 'full_get_sha256'
                    and remote.get('bytes') == item.get('bytes') and remote.get('sha256') == sha):
                families[(course, parent)].append((track != 'screen', own != parent, own, entry, item))
                break
    selected = [min(group, key=lambda v: v[:3])[3:] for group in families.values()]
    return sorted(selected, key=lambda pair: pair[0].get('publishedAt') or 0, reverse=True)


def course_names():
    # Read the kernel's actual course names; avoid substituting lecture titles for courses.
    sql = "SELECT coalesce(json_object_agg(id,coalesce(nullif(name,''),code)), '{}'::json) FROM courses"
    result = subprocess.run(['docker', 'exec', 'study-postgres-1', 'psql', '-XAt', '-v',
                             'ON_ERROR_STOP=1', '-U', 'study_kernel', '-d', 'study_kernel', '-c', sql],
                            check=True, capture_output=True, timeout=30)
    return json.loads(result.stdout)


def r2_prefix(metadata):
    published = metadata['publishedAt']
    stamp = datetime.fromtimestamp(published, timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ') if published is not None else 'publication-unknown'
    course = re.sub(r'[^\w.-]+', '-', metadata['courseName']).strip('-.')[:80] or 'course'
    return f"course-recording-guides/{metadata['courseId']}-{course}/{stamp}/{metadata['videoSha256']}"


def eligible_bundle(bundle, sha, seconds):
    source = bundle.get('source') or {}
    cues = bundle.get('cues')
    return (bundle.get('videoSha256') == sha and isinstance(seconds, (int, float)) and 0 < seconds <= 21600
            and source.get('clipStartMs') == 0 and source.get('timestampBasis') == 'source-absolute'
            and abs(source.get('clipEndMs', 0) - seconds * 1000) <= 1000
            and isinstance(cues, list) and bool(cues))


def cache_dir(path):
    path.mkdir(exist_ok=True)
    if os.name == 'posix':
        os.chown(path, -1, 1000)
    path.chmod(0o750)


def local_version(root):
    try:
        version = json.loads((root / 'current.json').read_bytes())['version']
        if not HASH.fullmatch(version):
            return None
        manifest = (root / version / 'manifest.json').read_bytes()
        if hash_bytes(manifest) != version:
            return None
        files = json.loads(manifest)['files']
        for fmt, (name, _) in FORMATS.items():
            if (root / version / name).stat().st_size != files[fmt]['bytes']:
                return None
        return version
    except (OSError, ValueError, KeyError, TypeError):
        return None


class HandoutStore:
    def __init__(self):
        import boto3
        from botocore.config import Config
        self.bucket = os.environ['S3_BUCKET']
        self.endpoint = os.environ['S3_ENDPOINT']
        self.client = boto3.client('s3', endpoint_url=self.endpoint, region_name='auto',
                                   config=Config(signature_version='s3v4', retries={'max_attempts': 2}))

    def head(self, key):
        from botocore.exceptions import ClientError
        try:
            return self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as error:
            if error.response['Error']['Code'] in ('404', 'NoSuchKey', 'NotFound'):
                return None
            raise

    def read(self, key, limit):
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        stream = response['Body']
        try:
            if response['ContentLength'] > limit:
                raise ValueError('GUIDE_OBJECT_TOO_LARGE')
            data = stream.read(limit + 1)
            if len(data) != response['ContentLength']:
                raise ValueError('GUIDE_OBJECT_LENGTH_MISMATCH')
            return data
        finally:
            stream.close()

    def put_verified(self, key, data, immutable=True):
        if not immutable or self.head(key) is None:
            self.client.put_object(Bucket=self.bucket, Key=key, Body=data, Metadata={'sha256': hash_bytes(data)})
        if self.read(key, len(data)) != data:
            raise ValueError('GUIDE_R2_CONTENT_MISMATCH')

    def video_url(self, key):
        return self.client.generate_presigned_url('get_object', Params={'Bucket': self.bucket, 'Key': key},
                                                 ExpiresIn=14400)


def materialize(store, prefix, version, root):
    """Rebuild even an empty local cache from the private R2 copy."""
    if not HASH.fullmatch(version):
        raise ValueError('GUIDE_R2_VERSION_INVALID')
    manifest = store.read(f'{prefix}/{version}/manifest.json', 16384)
    doc = json.loads(manifest)
    if hash_bytes(manifest) != version or doc['videoSha256'] != root.name:
        raise ValueError('GUIDE_R2_MANIFEST_MISMATCH')
    cache_dir(root)
    target = root / version
    cache_dir(target)
    for fmt, (name, limit) in FORMATS.items():
        data = store.read(f'{prefix}/{version}/{name}', limit)
        ref = doc['files'][fmt]
        if len(data) != ref['bytes'] or hash_bytes(data) != ref['sha256']:
            raise ValueError('GUIDE_R2_ASSET_MISMATCH')
        write_atomic(target / name, data, True)
    write_atomic(target / 'manifest.json', manifest, True)
    write_atomic(root / 'current.json', encode({'version': version}), True)


def publish_one(store, archive, entry, item, names):
    sha = item['sha256']
    sub = SUBTITLES / (sha + '.json')
    if not sub.is_file():
        return 'awaiting_transcript'
    course = entry['courseId']
    if not names.get(course):
        return 'awaiting_course_name'
    metadata = dict(courseName=names[course], courseId=course, title=entry.get('title') or '',
                    publishedAt=entry.get('publishedAt'), videoSha256=sha, durationSeconds=entry.get('durationSeconds'))
    if metadata['publishedAt'] is not None and not isinstance(metadata['publishedAt'], int):
        raise ValueError('INVALID_PUBLICATION_TIME')
    root = PUBLISHED / sha
    state_file = STATE / (sha + '.json')
    previous = json.loads(state_file.read_bytes()) if state_file.is_file() else {}
    stat = sub.stat()
    fingerprint = [stat.st_mtime_ns, stat.st_size, hash_bytes(encode(metadata)), REVISION]
    local = local_version(root)
    if local and previous.get('version') == local and previous.get('fingerprint') == fingerprint:
        return 'current'
    raw = sub.read_bytes()
    bundle = json.loads(raw)
    if not eligible_bundle(bundle, sha, metadata['durationSeconds']):
        return 'awaiting_full_transcript'
    translated = sum(bool(c.get('zh')) for c in bundle['cues'])
    complete = translated == len(bundle['cues'])
    # Publish on English availability, then once all Chinese is ready. Stable
    # English evidence avoids rebuilding the same slides for every translation batch.
    signature = hash_bytes(encode([REVISION, metadata, bundle['source']['subtitleSha256'],
                                   hash_bytes(raw) if complete else 'partial']))
    prefix = r2_prefix(metadata)
    pointer = f'{prefix}/current.json'
    remote = json.loads(store.read(pointer, 2048)) if store.head(pointer) else {}
    english_basis = hash_bytes(encode([REVISION, metadata, bundle['source']['subtitleSha256']]))
    keep_bilingual = not complete and remote.get('complete') is True and remote.get('englishBasis') == english_basis
    if signature == remote.get('input') or keep_bilingual:
        version = remote['version']
        if local != version:
            materialize(store, prefix, version, root)
        outcome = 'current' if local == version else 'restored'
    else:
        key = archive.object_key(course, entry['entryId'], item)
        if not archive.matches(item.get('remote'), store.head(key), item, store, key):
            raise ValueError('SOURCE_R2_IDENTITY_CHANGED')
        from slide_handout import build_handout
        with tempfile.TemporaryDirectory(dir=STATE) as temp:
            out = Path(temp)
            frames = build_handout(store.video_url(key), bundle, {**metadata, 'frameCacheDir': str(STATE / 'frames')}, out)
            files = {}
            for fmt, (name, limit) in FORMATS.items():
                if not 0 < (out / name).stat().st_size <= limit:
                    raise ValueError('GUIDE_ASSET_SIZE_INVALID')
                data = (out / name).read_bytes()
                files[fmt] = dict(bytes=len(data), sha256=hash_bytes(data))
            doc = {k: v for k, v in metadata.items() if k != 'durationSeconds'}
            doc.update(schemaVersion=2, clipStartMs=0, clipEndMs=bundle['source']['clipEndMs'],
                       frameCount=frames, translatedCues=translated, totalCues=len(bundle['cues']), files=files)
            manifest = encode(doc)
            version = hash_bytes(manifest)
            for name, _ in FORMATS.values():
                store.put_verified(f'{prefix}/{version}/{name}', (out / name).read_bytes())
            store.put_verified(f'{prefix}/{version}/manifest.json', manifest)
            store.put_verified(pointer, encode(dict(version=version, input=signature, complete=complete,
                                                    englishBasis=english_basis)), immutable=False)
            materialize(store, prefix, version, root)
        outcome = 'published'
    write_atomic(state_file, encode(dict(version=version, fingerprint=fingerprint)))
    return outcome


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--max-jobs', type=int, default=3)
    parser.add_argument('--source-sha', type=str)
    args = parser.parse_args()
    if not 1 <= args.max_jobs <= 12 or (args.source_sha and not HASH.fullmatch(args.source_sha)):
        parser.error('Invalid job bound or source SHA')
    import fcntl
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache_dir(PUBLISHED)
    with (STATE / 'worker.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        spec = importlib.util.spec_from_file_location('recording_r2', Path(__file__).with_name('r2-archive.py'))
        archive = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(archive)
        manifest = json.loads(Path('/srv/study-course-recordings/manifest.json').read_bytes())
        names, store = course_names(), HandoutStore()
        backoff = STATE / 'retry.json'
        retry = json.loads(backoff.read_bytes()) if backoff.exists() else {}
        counts = collections.Counter()
        selected = choose_sources(manifest)
        owners = collections.defaultdict(set)
        for entry, item in selected:
            owners[item['sha256']].add(entry['courseId'])
        for entry, item in selected:
            sha = item['sha256']
            if args.source_sha and args.source_sha != sha:
                continue
            if len(owners[sha]) > 1:
                counts['ambiguous_course'] += 1
                continue
            if not args.source_sha and retry.get(sha, 0) > time.time():
                continue
            try:
                outcome = publish_one(store, archive, entry, item, names)
                counts[outcome] += 1
                if retry.pop(sha, None) is not None:
                    write_atomic(backoff, encode(retry))
                if outcome in ('published','restored'):
                    print(sha[:12], outcome, flush=True)
            except Exception as error:
                counts['failed'] += 1
                retry[sha] = int(time.time()) + 4 * 3600
                # SDK errors, FFmpeg commands and exceptions may include signed URLs.
                print(sha[:12], 'failed', type(error).__name__, flush=True)
                write_atomic(backoff, encode(retry))
            if counts['published'] + counts['restored'] + counts['failed'] >= args.max_jobs:
                break
        print(json.dumps(counts), flush=True)
        if counts['failed'] or (args.source_sha and not counts):
            raise SystemExit(1)


if __name__ == '__main__':
    main()
