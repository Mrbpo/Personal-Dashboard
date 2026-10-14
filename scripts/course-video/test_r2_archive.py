import importlib.util
import tempfile
import tarfile
import json
import unittest
from pathlib import Path
from archive import sha256, verified_files

spec = importlib.util.spec_from_file_location('r2_archive', Path(__file__).with_name('r2-archive.py'))
r2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r2)
snapshot_spec = importlib.util.spec_from_file_location('thin_snapshot', Path(__file__).with_name('thin-snapshot.py'))
snapshot = importlib.util.module_from_spec(snapshot_spec)
snapshot_spec.loader.exec_module(snapshot)


class ObjectArchiveTests(unittest.TestCase):
    def test_thin_snapshot_retains_captions_but_no_video_or_auth(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            (root / 'original.mp4').write_bytes(b'VIDEO_MUST_NOT_BE_BACKED_UP')
            caption = root / 'caption.vtt'
            caption.write_bytes(b'WEBVTT\n\n00:00.000 --> 00:01.000\nOriginal caption\n')
            manifest = {'entries': {'example': {'sourceURL': 'https://example.invalid/path?ks=SECRET', 'files': [
                {'kind': 'video', 'path': 'original.mp4'}, {'kind': 'caption', 'path': caption.name, 'sha256': sha256(caption)}]}}}
            (root / 'manifest.json').write_text(json.dumps(manifest))
            destination = root / 'backup' / 'snapshot.tar'
            result = snapshot.build_snapshot(root, destination)
            self.assertEqual(result['videoFilesIncluded'], 0)
            with tarfile.open(destination) as bundle:
                self.assertNotIn('original.mp4', bundle.getnames())
                self.assertEqual(bundle.extractfile('caption.vtt').read(), caption.read_bytes())
                self.assertNotIn(b'SECRET', bundle.extractfile('manifest.json').read())
            before = destination.read_bytes()
            manifest['entries']['example']['ks'] = 'SECRET'
            (root / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'AUTH_DATA_NOT_ALLOWED'):
                snapshot.build_snapshot(root, destination)
            self.assertEqual(destination.read_bytes(), before)

    def test_only_nonoverlapping_complete_lifecycle_evidence_is_safe(self):
        proof = {'bucket': 'dashboard', 'endpointHost': 'example.r2.cloudflarestorage.com', 'prefix': r2.PREFIX,
                 'completeRuleInventory': True, 'publicAccessDisabled': True, 'reviewedBy': 'admin',
                 'publicAccessEvidence': 'Operator confirms private destination',
                 'reviewedAt': '2026-10-13', 'evidenceReference': 'user-screenshot',
                 'rules': [{'enabled': True, 'prefix': 'study-backups/', 'filterKind': 'prefix', 'deletesObjects': True}]}
        r2.validate_lifecycle(proof, 'dashboard', 'https://example.r2.cloudflarestorage.com')
        proof['rules'][0]['prefix'] = ''
        with self.assertRaisesRegex(ValueError, 'RECORDINGS_EXPIRATION_RULE'):
            r2.validate_lifecycle(proof, 'dashboard', 'https://example.r2.cloudflarestorage.com')
        proof['rules'] = []
        proof['completeRuleInventory'] = False
        with self.assertRaisesRegex(ValueError, 'LIFECYCLE_NOT_VERIFIED'):
            r2.validate_lifecycle(proof, 'dashboard', 'https://example.r2.cloudflarestorage.com')

    def test_upload_metadata_cannot_replace_full_content_verification(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            path = root / 'original.mp4'
            path.write_bytes(b'original bytes')
            item = {'bytes': path.stat().st_size, 'sha256': sha256(path)}
            class Store:
                bucket = 'dashboard'
                endpoint = 'https://example.r2.cloudflarestorage.com'
                def head(self, key):
                    return {'ContentLength': item['bytes'], 'ETag': 'same', 'Metadata': {'sha256': item['sha256']}}
                def get_hash(self, key):
                    return '0' * 64, item['bytes']
            with self.assertRaisesRegex(ValueError, 'REMOTE_SHA_MISMATCH'):
                r2.ensure_remote(Store(), path, 'course-recordings/example', item)
            self.assertTrue(path.exists())
            remote = {'state': 'verified', 'method': 'full_get_sha256', 'bucket': Store.bucket,
                      'endpointHost': 'example.r2.cloudflarestorage.com', 'key': 'course-recordings/example',
                      'sha256': item['sha256'], 'bytes': item['bytes'], 'etag': 'same'}
            self.assertFalse(r2.matches(remote, None, item, Store(), remote['key']))
            self.assertFalse(r2.matches(remote, {'ContentLength': item['bytes'], 'ETag': 'changed'}, item, Store(), remote['key']))

    def test_release_requires_full_sha_proof_and_weekly_scan_retains_remote(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory).resolve()
            path = root / 'original.mp4'
            path.write_bytes(b'original bytes')
            item = {'kind': 'video', 'path': path.name, 'bytes': path.stat().st_size, 'sha256': sha256(path)}
            with self.assertRaisesRegex(ValueError, 'REMOTE_NOT_VERIFIED'):
                r2.release_local(root, item)
            self.assertTrue(path.exists())
            item['remote'] = {'state': 'verified', 'method': 'full_get_sha256', 'sha256': item['sha256'],
                              'bytes': item['bytes'], 'etag': 'same', 'key': 'course-recordings/example'}
            r2.release_local(root, item)
            self.assertFalse(path.exists())
            self.assertTrue(verified_files(root, {'files': [item]}))


if __name__ == '__main__':
    unittest.main()
