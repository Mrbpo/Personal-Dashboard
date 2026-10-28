import importlib.util
import unittest
import json
import tempfile
import os
import sys
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch
from datetime import datetime, timezone, timedelta
from pathlib import Path

spec = importlib.util.spec_from_file_location('control_runner', Path(__file__).with_name('control-runner.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ControlRunnerTest(unittest.TestCase):
    @unittest.skipUnless(os.name == 'posix', 'requires POSIX file modes')
    def test_status_directory_remains_readable_after_service_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request = {'id': 'c552462f-78e5-4dcf-986e-46bef448bd52', 'action': 'subtitle',
                       'videoSha256': 'a' * 64, 'requestedAt': datetime.now(timezone.utc).isoformat()}
            previous = os.umask(0o077)
            try:
                runner.request_subtitle(root, {'entries': {}}, root / 'subtitles', request, 1000)
            finally:
                os.umask(previous)
            self.assertEqual((root / 'subtitle-results').stat().st_mode & 0o777, 0o750)
            self.assertEqual((root / 'subtitle-results' / ('a' * 64 + '.json')).stat().st_mode & 0o777, 0o640)

    def test_manual_subtitle_prioritizes_current_source_without_resetting_running_failed_or_budget_state(self):
        clock = datetime.now(timezone.utc)
        sha = 'a' * 64
        request = {'id': 'c552462f-78e5-4dcf-986e-46bef448bd52', 'action': 'subtitle',
                   'videoSha256': sha, 'requestedAt': clock.isoformat()}
        runner.validated_request(request, clock)
        with self.assertRaises(ValueError):
            runner.validated_request({**request, 'videoSha256': '../file'}, clock)
        manifest = {'entries': {'a': {'state': 'archived', 'courseId': '123', 'entryId': '0_a',
            'files': [{'kind': 'video', 'sha256': sha, 'bytes': 10, 'remote': {'state': 'verified',
                'method': 'full_get_sha256', 'sha256': sha, 'bytes': 10}}]}}}
        # Windows has no fcntl; exercise the queue transaction logic there while Linux CI uses the real lock.
        lock_module = patch.dict(sys.modules, {'fcntl': SimpleNamespace(flock=lambda *_: None, LOCK_EX=2)}) if os.name == 'nt' else nullcontext()
        with tempfile.TemporaryDirectory() as directory, lock_module:
            root = Path(directory)
            subtitles = root / 'subtitles'
            subtitles.mkdir()
            def submit(row):
                runner.publish(root / 'subtitle-queue.json', {'schemaVersion': 1, 'jobs': [
                    {'videoSha256': 'b' * 64, 'state': 'pending'}, {'videoSha256': sha, **row}]}, 1000)
                return runner.request_subtitle(root, manifest, subtitles, request, 1000, clock)
            result = submit({'state': 'pending', 'checkpoint': 'saved', 'attempts': 3})
            queue = runner.read_json(root / 'subtitle-queue.json', {})
            self.assertEqual(result['state'], 'queued')
            self.assertEqual(queue['jobs'][0]['videoSha256'], sha)
            self.assertEqual(queue['jobs'][0]['checkpoint'], 'saved')
            self.assertEqual(queue['jobs'][0]['attempts'], 3)
            self.assertEqual(submit({'state': 'running', 'leaseExpiresAt': (clock + timedelta(minutes=20)).isoformat()})['state'], 'running')
            self.assertEqual(submit({'state': 'failed', 'reasonCode': 'REVIEW_LEDGER'})['reasonCode'], 'SUBTITLE_REVIEW_REQUIRED')
            before = (clock + timedelta(hours=3)).isoformat()
            self.assertEqual(submit({'state': 'pending', 'notBefore': before})['state'], 'deferred')
            self.assertEqual(runner.read_json(root / 'subtitle-queue.json', {})['jobs'][0]['notBefore'], before)
            (root / 'subtitle-pending').unlink(missing_ok=True)
            self.assertEqual(submit({'state': 'pending', 'notBefore': before, 'reasonCode': 'SUBTITLE_RESOURCE_RESERVE',
                                     'checkpoint': 'saved', 'attempts': 3})['state'], 'queued')
            resumed = runner.read_json(root / 'subtitle-queue.json', {})['jobs'][0]
            self.assertIsNone(resumed['notBefore'])
            self.assertEqual(resumed['checkpoint'], 'saved')
            self.assertEqual(resumed['attempts'], 3)
            self.assertTrue((root / 'subtitle-pending').exists())
            self.assertEqual(submit({'state': 'pending', 'notBefore': before, 'reasonCode': 'SUBTITLE_BUDGET_DEFERRED'})['state'], 'deferred')
            stale = {**request, 'videoSha256': 'c' * 64}
            self.assertEqual(runner.request_subtitle(root, manifest, subtitles, stale, 1000, clock)['reasonCode'], 'SUBTITLE_SOURCE_UNAVAILABLE')

    def test_control_request_is_fixed_and_bounded_not_a_shell_contract(self):
        clock = datetime(2026, 10, 26, tzinfo=timezone.utc)
        request = {'id': 'c552462f-78e5-4dcf-986e-46bef448bd52', 'action': 'reauthorize', 'requestedAt': clock.isoformat()}
        self.assertEqual(runner.validated_request(request, clock), request)
        for invalid in ({**request, 'command': 'anything'}, {**request, 'action': 'bash'}, {**request, 'id': '../file'},
                        {**request, 'requestedAt': (clock - timedelta(days=2)).isoformat()}):
            with self.assertRaises((ValueError, TypeError)):
                runner.validated_request(invalid, clock)

    def test_only_observed_auth_failure_prompts_reauthorization(self):
        self.assertEqual(runner.classify_result(2, [{'state': 'needs_browser_verification'}]), ('needs_auth', 'AUTHORIZATION_REQUIRED'))
        self.assertEqual(runner.classify_result(2, []), ('failed', 'SYNC_FAILED'))
        self.assertEqual(runner.classify_result(0, []), ('completed', 'SYNC_COMPLETED'))
        self.assertEqual(runner.classify_result(2, [{'state': 'grant_failed', 'code': 'CANVAS_HTTP_401'}]), ('needs_auth', 'CANVAS_ACCESS_REQUIRED'))

    def test_queue_deduplicates_verified_originals_and_preserves_existing_job_state(self):
        digest = 'a' * 64
        file = {'kind': 'video', 'sha256': digest, 'bytes': 10,
                'remote': {'state': 'verified', 'method': 'full_get_sha256', 'sha256': digest, 'bytes': 10}}
        manifest = {'entries': {'a': {'state': 'archived', 'courseId': '123', 'entryId': '0_a', 'files': [file]},
                                'b': {'state': 'archived', 'courseId': '123', 'entryId': '0_b', 'files': [file]}}}
        first = runner.subtitle_jobs(manifest, {})
        self.assertEqual(len(first['jobs']), 1)
        first['jobs'][0]['state'] = 'completed'
        self.assertEqual(runner.subtitle_jobs(manifest, first)['jobs'][0]['state'], 'completed')
        file['remote']['state'] = 'unavailable'
        self.assertEqual(runner.subtitle_jobs(manifest, {})['jobs'], [])

    def test_partial_sample_does_not_mark_full_lecture_complete(self):
        digest = 'a' * 64
        manifest = {'entries': {'a': {'state': 'archived', 'courseId': '123', 'entryId': '0_a', 'durationSeconds': 100,
            'files': [{'kind': 'video', 'sha256': digest, 'bytes': 10, 'remote': {'state': 'verified',
                'method': 'full_get_sha256', 'sha256': digest, 'bytes': 10}}]}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / (digest + '.json')
            bundle = {'videoSha256': digest, 'source': {'clipStartMs': 10, 'clipEndMs': 100000}, 'cues': [{'zh': '译文'}]}
            path.write_text(json.dumps(bundle))
            self.assertEqual(runner.subtitle_jobs(manifest, {}, Path(directory))['jobs'][0]['state'], 'pending')
            bundle['source']['clipStartMs'] = 0
            path.write_text(json.dumps(bundle))
            self.assertEqual(runner.subtitle_jobs(manifest, {}, Path(directory))['jobs'][0]['state'], 'completed')

    def test_expired_or_unknown_running_lease_is_requeued_without_losing_checkpoint(self):
        clock = datetime(2026, 10, 26, tzinfo=timezone.utc)
        jobs = [{'videoSha256': char * 64, 'state': 'running', 'notBefore': '2026-10-27T00:00:00Z',
                 'checkpoint': 'saved-english'} for char in 'abcde']
        jobs[0]['leaseExpiresAt'] = (clock - timedelta(seconds=1)).isoformat()
        jobs[1]['leaseExpiresAt'] = 'invalid'
        jobs[3]['leaseExpiresAt'] = (clock + timedelta(hours=1)).isoformat()
        jobs[4]['state'] = 'failed'
        result = runner.subtitle_jobs({'entries': {}}, {'jobs': jobs}, clock=clock)['jobs']
        self.assertEqual([job['state'] for job in result], ['pending', 'pending', 'pending', 'running', 'failed'])
        self.assertTrue(all(job['notBefore'] == '2026-10-27T00:00:00Z' and job['checkpoint'] == 'saved-english' for job in result))
