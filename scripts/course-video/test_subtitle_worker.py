import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location('subtitle_worker', Path(__file__).with_name('subtitle-worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SubtitleWorkerTests(unittest.TestCase):
    def test_budget_deferral_requires_proven_zero_charge_and_future_aware_timestamp(self):
        now = datetime.now(timezone.utc)
        future = (now + timedelta(days=1)).isoformat()
        ledger = {'sourceHash': 'a' * 64, 'calls': [{'state': 'rejected', 'charged': 0, 'retryAt': future}]}
        self.assertEqual(worker.budget_retry_at(ledger, 'a' * 64, now), future)
        self.assertIsNone(worker.budget_retry_at(ledger, 'b' * 64, now))
        for changes in ({'state': 'pending'}, {'state': 'settled'}, {'charged': 0.01}, {'charged': False},
                        {'retryAt': now.replace(tzinfo=None).isoformat()},
                        {'retryAt': (now - timedelta(seconds=1)).isoformat()}, {'retryAt': 'not-a-time'}):
            changed = {'sourceHash': 'a' * 64, 'calls': [{**ledger['calls'][0], **changes}]}
            self.assertIsNone(worker.budget_retry_at(changed, 'a' * 64, now))

    def test_claim_recovers_expired_lease_but_never_retries_failed_or_future_job(self):
        now = datetime.now(timezone.utc)
        base = {'videoSha256': 'a' * 64, 'courseId': '123', 'entryId': '0_test'}
        failed = {**base, 'state': 'failed', 'reasonCode': 'REVIEW_LEDGER'}
        delayed = {**base, 'state': 'pending', 'notBefore': (now + timedelta(minutes=5)).isoformat()}
        expired = {**base, 'videoSha256': 'b' * 64, 'state': 'running',
                   'leaseExpiresAt': (now - timedelta(seconds=1)).isoformat(), 'customMetadata': 'preserved'}
        selected = worker.claim_job({'jobs': [failed, delayed, expired]}, now)
        self.assertEqual(selected['videoSha256'], 'b' * 64)
        self.assertEqual(selected['customMetadata'], 'preserved')
        self.assertEqual(failed['state'], 'failed')
        self.assertEqual(delayed['state'], 'pending')

    def test_cached_chunk_requires_exact_version_window_model_and_real_vtt_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'sample.vtt'
            path.write_text('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOriginal text\n', encoding='utf-8')
            model = {'repository': 'pinned/model', 'revision': 'b' * 40, 'sha256': 'c' * 64}
            proof = {'sourceVideoSha256': 'a' * 64, 'subtitleSha256': worker.digest(path),
                     'model': model['repository'], 'modelRevision': model['revision'], 'modelSha256': model['sha256'],
                     'language': 'en', 'computeType': 'int8', 'timestampBasis': 'clip-relative',
                     'clipStartMs': 600000, 'clipEndMs': 900000, 'sourceAudioSha256': 'd' * 64}
            path.with_suffix('.vtt.provenance.json').write_text(json.dumps(proof), encoding='utf-8')
            self.assertTrue(worker.cached_chunk(path, 'a' * 64, 600000, 900000, model))
            self.assertFalse(worker.cached_chunk(path, 'a' * 64, 0, 300000, model))
            path.write_text('changed', encoding='utf-8')
            self.assertFalse(worker.cached_chunk(path, 'a' * 64, 600000, 900000, model))

    def test_merge_shifts_each_chunk_once_and_rejects_cross_window_timing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second, output = root / 'first.vtt', root / 'second.vtt', root / 'merged.vtt'
            first.write_text('WEBVTT\n\n00:00:00.430 --> 00:00:02.430\nFirst\n', encoding='utf-8')
            second.write_text('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nSecond\n', encoding='utf-8')
            original = second.read_bytes()
            count = worker.merge_chunks([(first, 0, 300000), (second, 300000, 600000)], output, 600000)
            self.assertEqual(count, 2)
            self.assertIn('00:05:01.000 --> 00:05:03.000', output.read_text())
            self.assertEqual(second.read_bytes(), original)
            with self.assertRaises(ValueError):
                worker.merge_chunks([(second, 300000, 300500)], output, 600000)
