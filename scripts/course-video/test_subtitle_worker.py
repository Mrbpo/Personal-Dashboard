import importlib.util
import json
import tempfile
import unittest
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from contextlib import nullcontext

spec = importlib.util.spec_from_file_location('subtitle_worker', Path(__file__).with_name('subtitle-worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SubtitleWorkerTests(unittest.TestCase):
    def test_budget_wait_does_not_stall_other_ready_english_jobs_or_spin_on_global_resource_shortage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            delayed = {'state': 'pending', 'notBefore': future}
            ready = {'state': 'pending'}
            with patch.object(worker, 'queue_lock', side_effect=lambda *_: nullcontext()):
                (root / 'subtitle-queue.json').write_text(json.dumps({'jobs': [delayed, ready]}))
                worker.wake_after_budget(root, ['budget'])
                self.assertTrue((root / 'subtitle-pending').exists())
                (root / 'subtitle-pending').unlink()
                worker.wake_after_budget(root, ['budget', 'resource'])
                self.assertFalse((root / 'subtitle-pending').exists())
                (root / 'subtitle-queue.json').write_text(json.dumps({'jobs': [delayed]}))
                worker.wake_after_budget(root, ['budget'])
                self.assertFalse((root / 'subtitle-pending').exists())

    def test_parallel_capacity_reserves_headroom_and_caps_at_two(self):
        self.assertEqual(worker.parallel_capacity(2, 4 * 1024**3, 4), 2)
        self.assertEqual(worker.parallel_capacity(2, 4 * 1024**3 - 1, 4), 1)
        self.assertEqual(worker.parallel_capacity(2, 8 * 1024**3, 2), 1)
        self.assertEqual(worker.parallel_capacity(1, 8 * 1024**3, 8), 1)
        with self.assertRaises(ValueError):
            worker.parallel_capacity(3, 8 * 1024**3, 8)

    def test_two_jobs_overlap_and_one_failure_does_not_cancel_the_other(self):
        barrier = threading.Barrier(2)
        lock = threading.Lock()
        counts = {'active': 0, 'maximum': 0}
        def process(job, *_):
            with lock:
                counts['active'] += 1
                counts['maximum'] = max(counts['maximum'], counts['active'])
            try:
                barrier.wait(timeout=3)
                if job['videoSha256'] == 'a' * 64:
                    raise ValueError('SAMPLE_FAILURE')
            finally:
                with lock:
                    counts['active'] -= 1
        jobs = [{'videoSha256': value * 64} for value in 'ab']
        with patch.object(worker, 'process_job', side_effect=process), patch.object(worker, 'update_job') as update:
            worker.run_batch(Path('.'), jobs, Path('.'), Path('.'), 60, 2)
        self.assertEqual(counts['maximum'], 2)
        outcomes = {call.args[1]['videoSha256']: call.args[2] for call in update.call_args_list}
        self.assertEqual(outcomes, {'a' * 64: 'failed', 'b' * 64: 'completed'})

    @unittest.skipUnless(os.name == 'posix', 'requires POSIX umask')
    def test_translation_input_is_group_readable_under_root_service_umask(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = os.umask(0o077)
            try:
                path = worker.translation_input_directory(Path(directory))
            finally:
                os.umask(previous)
            self.assertEqual(path.stat().st_mode & 0o777, 0o750)

    def test_resource_admission_uses_bounded_audio_scratch_not_fixed_video_space(self):
        required = worker.scratch_reserve_bytes(3600)
        self.assertGreater(required, 3 * 1024**3)
        self.assertLess(worker.scratch_reserve_bytes(21600), 6 * 1024**3)
        with patch.object(worker.Path, 'read_text', return_value='MemAvailable: 4194304 kB\n'), \
                patch.object(worker.shutil, 'disk_usage', return_value=SimpleNamespace(free=12 * 1024**3)):
            worker.resource_reserve(Path('.'), 3600)
            with patch.object(worker.shutil, 'disk_usage', return_value=SimpleNamespace(free=required - 1)):
                with self.assertRaises(worker.ResourceBound):
                    worker.resource_reserve(Path('.'), 3600)
            with patch.object(worker.Path, 'read_text', return_value='MemAvailable: 1048576 kB\n'):
                with self.assertRaises(worker.ResourceBound):
                    worker.resource_reserve(Path('.'), 3600)
        for duration in (True, 0, -1, float('nan'), 21601):
            with self.assertRaises(ValueError):
                worker.scratch_reserve_bytes(duration)

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

    def test_claim_recovers_null_and_timezone_missing_leases(self):
        now = datetime.now(timezone.utc)
        for lease in (None, now.replace(tzinfo=None).isoformat()):
            job = {'videoSha256': 'a' * 64, 'courseId': '123', 'entryId': '0_test',
                   'state': 'running', 'leaseExpiresAt': lease}
            selected = worker.claim_job({'jobs': [job]}, now)
            self.assertIsNotNone(selected)
            self.assertEqual(selected['state'], 'running')
            self.assertGreater(datetime.fromisoformat(selected['leaseExpiresAt']), now)

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
