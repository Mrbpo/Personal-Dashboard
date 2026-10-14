#!/usr/bin/env python3
"""Manual original-byte object archive. Default dry-run; no encoding or public URLs."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from archive import atomic_json, sha256

PREFIX = 'course-recordings/'
RESERVE = 15 * 1024**3


def object_key(course, entry, item):
    path = Path(item['path'])
    if (not re.fullmatch(r'[1-9][0-9]*', course) or not re.fullmatch(r'[01]_[A-Za-z0-9]+', entry)
            or not re.fullmatch(r'[a-f0-9]{64}', item['sha256']) or path.suffix.lower() not in ('.mp4', '.mkv', '.webm', '.mov', '.m4v')):
        raise ValueError('INVALID_OBJECT_IDENTITY')
    if len(path.parts) != 4 or path.parts[:2] != (course, entry) or not re.fullmatch(r'version-(?:[0-9]+|unknown)', path.parts[2]):
        raise ValueError('INVALID_VERSION_PATH')
    return PREFIX + '/'.join((course, entry, path.parts[2], item['sha256'] + path.suffix.lower()))


def validate_lifecycle(proof, bucket, endpoint):
    if (proof.get('bucket') != bucket or proof.get('endpointHost') != urlparse(endpoint).hostname
            or proof.get('prefix') != PREFIX or proof.get('completeRuleInventory') is not True
            or proof.get('publicAccessDisabled') is not True or not proof.get('publicAccessEvidence') or not proof.get('reviewedBy')
            or not proof.get('reviewedAt') or not proof.get('evidenceReference') or not isinstance(proof.get('rules'), list)):
        raise ValueError('LIFECYCLE_NOT_VERIFIED')
    for rule in proof['rules']:
        # Normalized full dashboard/API inventory. Unknown/tag filters cannot
        # establish prefix safety. Multipart-abort rules do not delete objects.
        if rule.get('enabled') is not True:
            if rule.get('enabled') is not False:
                raise ValueError('LIFECYCLE_NOT_VERIFIED')
            continue
        if not isinstance(rule.get('prefix'), str) or rule.get('filterKind') != 'prefix':
            raise ValueError('LIFECYCLE_FILTER_UNSUPPORTED')
        if rule.get('deletesObjects') is not False:
            if rule.get('deletesObjects') is not True:
                raise ValueError('LIFECYCLE_NOT_VERIFIED')
            prefix = rule['prefix']
            if PREFIX.startswith(prefix) or prefix.startswith(PREFIX):
                raise ValueError('RECORDINGS_EXPIRATION_RULE')


class Store:
    def __init__(self, endpoint, bucket):
        self.endpoint, self.bucket = endpoint, bucket
        self.base = ['aws', '--endpoint-url', endpoint, '--region', 'auto', '--no-cli-pager']

    def call(self, args, missing=False):
        result = subprocess.run(self.base + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            # Only fixed missing-object errors allow creation. AccessDenied,
            # transport failures and unknown errors must never mean absent.
            if missing and re.search(rb'\((?:404|NoSuchKey|NotFound)\)', result.stderr):
                return None
            raise RuntimeError('OBJECT_REQUEST_FAILED')
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def head(self, key):
        return self.call(['s3api', 'head-object', '--bucket', self.bucket, '--key', key], missing=True)

    def upload(self, path, key, digest):
        self.call(['s3', 'cp', '--only-show-errors', str(path), 's3://' + self.bucket + '/' + key,
                   '--metadata', 'sha256=' + digest])

    def get_hash(self, key, output=None):
        digest, size = hashlib.sha256(), 0
        destination = output.open('ab') if output else None
        process = subprocess.Popen(self.base + ['s3', 'cp', '--only-show-errors', 's3://' + self.bucket + '/' + key, '-'],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            for block in iter(lambda: process.stdout.read(1024 * 1024), b''):
                if output and shutil.disk_usage(output.parent).free < RESERVE + len(block):
                    raise RuntimeError('CACHE_CAPACITY_BLOCKED')
                digest.update(block)
                size += len(block)
                if destination:
                    destination.write(block)
            if process.wait() != 0:
                raise RuntimeError('OBJECT_GET_FAILED')
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
            if destination:
                destination.close()
        return digest.hexdigest(), size


def matches(remote, head, item, store, key):
    return bool(remote and head and remote.get('state') == 'verified' and remote.get('method') == 'full_get_sha256'
                and remote.get('bucket') == store.bucket and remote.get('endpointHost') == urlparse(store.endpoint).hostname
                and remote.get('key') == key and remote.get('sha256') == item['sha256'] and remote.get('bytes') == item['bytes']
                and remote.get('etag') == head.get('ETag') and head.get('ContentLength') == item['bytes'])


def ensure_remote(store, path, key, item):
    head = store.head(key)
    if matches(item.get('remote'), head, item, store, key):
        return item['remote'], False
    if head is None:
        if not path.is_file() or path.stat().st_size != item['bytes'] or sha256(path) != item['sha256']:
            raise ValueError('LOCAL_SHA_MISMATCH')
        store.upload(path, key, item['sha256'])
        head = store.head(key)
    if not head or head.get('ContentLength') != item['bytes']:
        raise ValueError('REMOTE_SIZE_MISMATCH')
    digest, size = store.get_hash(key)
    after = store.head(key)
    if digest != item['sha256'] or size != item['bytes']:
        raise ValueError('REMOTE_SHA_MISMATCH')
    if not after or head.get('ETag') != after.get('ETag') or after.get('ContentLength') != size:
        raise ValueError('REMOTE_CHANGED_DURING_VERIFICATION')
    return {'state': 'verified', 'method': 'full_get_sha256', 'bucket': store.bucket,
            'endpointHost': urlparse(store.endpoint).hostname, 'key': key, 'etag': after['ETag'],
            'sha256': digest, 'bytes': size, 'verifiedAt': int(time.time())}, True


def release_local(root, item):
    path = (root / item['path']).resolve()
    if not path.is_relative_to(root) or not path.is_file() or sha256(path) != item['sha256']:
        raise ValueError('LOCAL_SHA_MISMATCH')
    remote = item.get('remote', {})
    if (remote.get('state') != 'verified' or remote.get('method') != 'full_get_sha256'
            or remote.get('sha256') != item['sha256'] or remote.get('bytes') != item['bytes']
            or not remote.get('etag') or not str(remote.get('key', '')).startswith(PREFIX)):
        raise ValueError('REMOTE_NOT_VERIFIED')
    path.unlink()  # Exact verified file only; directories/other assets remain.
    item['localCache'] = {'state': 'released', 'releasedAt': int(time.time())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, default=Path('/srv/study-course-recordings'))
    parser.add_argument('--course-id')
    parser.add_argument('--entry-id')
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--upload', action='store_true')
    parser.add_argument('--release-cache', action='store_true')
    parser.add_argument('--fetch-cache', action='store_true')
    parser.add_argument('--verify-only', action='store_true', help='HEAD-check previously content-verified objects; no upload or release')
    parser.add_argument('--lock-fd', type=int, help=argparse.SUPPRESS)
    parser.add_argument('--lifecycle-evidence', type=Path)
    args = parser.parse_args()
    if args.limit < 0 or sum((args.upload, args.fetch_cache, args.verify_only)) > 1 or args.release_cache and not args.upload:
        parser.error('Invalid operation; release-cache requires upload/verification')
    root = args.archive.resolve()
    lock = None
    if not args.dry_run and (args.upload or args.fetch_cache or args.verify_only):
        import fcntl
        lock_path = Path('/srv/study-course-video-state/manual-run.lock')
        if args.lock_fd is not None:
            if Path('/proc/self/fd/' + str(args.lock_fd)).resolve() != lock_path.resolve():
                raise ValueError('INVALID_INHERITED_LOCK')
            lock = os.fdopen(os.dup(args.lock_fd), 'a')
        else:
            lock = lock_path.open('a')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    manifest_path = root / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    ledger = json.loads((root / 'reports' / 'decoder-ledger.json').read_text())
    records = []
    for identity, entry in manifest['entries'].items():
        if args.course_id and entry.get('courseId') != args.course_id or args.entry_id and entry.get('entryId') != args.entry_id:
            continue
        for item in entry.get('files', []):
            if item.get('kind') != 'video' or entry.get('state') != 'archived':
                continue
            if args.verify_only and not item.get('remote'):
                continue  # Newly downloaded local bytes await their first decoder/upload.
            if item.get('selectedFormat', {}).get('isOriginalSource') is False or Path(item['path']).name.split('.')[0] != 'original':
                raise ValueError('ONLY_ORIGINAL_FILES_SUPPORTED')
            if not ledger.get(identity + ':' + item['sha256'], {}).get('passed'):
                raise ValueError('DECODER_EVIDENCE_REQUIRED')
            path = (root / item['path']).resolve()
            if not path.is_relative_to(root):
                raise ValueError('INVALID_LOCAL_PATH')
            records.append((item, path, object_key(entry['courseId'], entry['entryId'], item)))
    if args.limit:
        records = records[:args.limit]
    preview = {'state': 'object_archive_plan', 'files': len(records), 'sourceBytes': sum(item['bytes'] for item, _, _ in records),
               'pendingBytes': sum(item['bytes'] for item, _, _ in records if item.get('remote', {}).get('state') != 'verified'),
               'localBytes': sum(item['bytes'] for item, path, _ in records if path.is_file()),
               'freeBytes': shutil.disk_usage(root).free, 'reservedBytes': RESERVE, 'prefix': PREFIX,
               'networkRequested': False, 'releaseRequested': args.release_cache,
               'keys': [key for _, _, key in records]}
    if args.dry_run or not (args.upload or args.fetch_cache or args.verify_only):
        print(json.dumps(preview), flush=True)
        return
    endpoint, bucket = os.environ.get('S3_ENDPOINT', ''), os.environ.get('S3_BUCKET', '')
    parsed = urlparse(endpoint)
    if (parsed.scheme != 'https' or not (parsed.hostname or '').endswith('.r2.cloudflarestorage.com') or parsed.query
            or parsed.username or parsed.password or parsed.path not in ('', '/') or not re.fullmatch(r'[a-z0-9][a-z0-9.-]+', bucket)):
        raise ValueError('INVALID_R2_CONFIG')
    if not args.lifecycle_evidence:
        raise ValueError('LIFECYCLE_NOT_VERIFIED')
    validate_lifecycle(json.loads(args.lifecycle_evidence.read_text()), bucket, endpoint)
    # Shared with manual collector; no manifest writer or dedicated profile race.
    with lock:
        store = Store(endpoint, bucket)
        for position, (item, path, key) in enumerate(records):
            if args.verify_only:
                if not item.get('remote'):
                    continue
                if not matches(item['remote'], store.head(key), item, store, key):
                    item['remote']['state'] = 'unavailable'
                    for entry in manifest['entries'].values():
                        if item in entry.get('files', []):
                            entry['state'] = 'retryable_failure'
                            entry['failureReason'] = 'remote_object_unavailable'
                    if manifest.get('scan', {}).get('courses') == [args.course_id]:
                        manifest['scan']['scopeComplete'] = False
                        manifest['archive'] = {'state': 'incomplete', 'failureReason': 'remote_object_unavailable'}
                    atomic_json(manifest_path, manifest)
                    raise ValueError('REMOTE_NOT_VERIFIED')
                item['remote']['lastHeadVerifiedAt'] = int(time.time())
            elif args.fetch_cache:
                if path.is_file() and sha256(path) == item['sha256']:
                    continue
                if shutil.disk_usage(root).free < item['bytes'] + RESERVE:
                    raise ValueError('CACHE_CAPACITY_BLOCKED')
                before = store.head(key)
                if not matches(item.get('remote'), before, item, store, key):
                    raise ValueError('REMOTE_NOT_VERIFIED')
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary = path.with_suffix(path.suffix + '.r2-cache-part')
                temporary.write_bytes(b'')
                digest, size = store.get_hash(key, temporary)
                if digest != item['sha256'] or size != item['bytes'] or not matches(item['remote'], store.head(key), item, store, key):
                    raise ValueError('REMOTE_SHA_MISMATCH')
                if path.exists():
                    path.rename(path.with_name('corrupt-' + sha256(path) + '-' + path.name))
                temporary.replace(path)
                item['localCache'] = {'state': 'available', 'fetchedAt': int(time.time())}
            else:
                remote, newly_verified = ensure_remote(store, path, key, item)
                item['remote'] = remote
                atomic_json(manifest_path, manifest)  # Durable proof precedes release.
                if args.release_cache and path.is_file():
                    release_local(root, item)
                print(json.dumps({'state': 'remote_verified', 'key': key, 'bytes': item['bytes'],
                                  'newFullGetVerification': newly_verified, 'localReleased': args.release_cache and not path.is_file()}), flush=True)
            atomic_json(manifest_path, manifest)
            if position + 1 == len(records) or Path(records[position + 1][1]).parts[-4] != path.parts[-4]:
                course = path.parts[-4]
                entries = [entry for entry in manifest['entries'].values() if entry.get('courseId') == course]
                videos = [file for entry in entries for file in entry.get('files', []) if file.get('kind') == 'video']
                pending = [entry['entryId'] for entry in entries if entry.get('state') != 'archived']
                report = {'courseId': course, 'recordedAt': int(time.time()), 'knownEntries': len(entries),
                    'archivedEntries': len(entries) - len(pending), 'pendingEntryIds': pending,
                    'remoteVerifiedFiles': sum(file.get('remote', {}).get('state') == 'verified' for file in videos),
                    'remoteVerifiedBytes': sum(file['bytes'] for file in videos if file.get('remote', {}).get('state') == 'verified'),
                    'releasedFiles': sum(file.get('localCache', {}).get('state') == 'released' for file in videos),
                    'currentGalleryScopeComplete': bool(manifest.get('scan', {}).get('courses') == [course] and manifest['scan'].get('scopeComplete'))}
                if manifest.get('scan', {}).get('courses') == [course] and manifest.get('historicalRecovery'):
                    report['historicalRecovery'] = manifest['historicalRecovery']
                atomic_json(root / 'reports' / ('r2-course-' + course + '.json'), report)
                result = subprocess.run([sys.executable, str(Path(__file__).with_name('thin-snapshot.py')),
                                         '--lock-fd', str(lock.fileno())], pass_fds=(lock.fileno(),), check=False)
                if result.returncode:
                    raise RuntimeError('THIN_SNAPSHOT_FAILED')
        print(json.dumps({'state': 'object_archive_complete', 'files': len(records), 'freeBytes': shutil.disk_usage(root).free}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if re.fullmatch(r'[A-Z_]{3,80}', str(error)) else 'OBJECT_ARCHIVE_FAILED'
        print(json.dumps({'state': 'object_archive_failed', 'code': code}), file=sys.stderr)
        raise SystemExit(2)
