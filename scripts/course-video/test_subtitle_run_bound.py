import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('subtitle_run_bound_worker', Path(__file__).with_name('subtitle-worker.py'))
assert spec is not None and spec.loader is not None
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SubtitleRunBoundTests(unittest.TestCase):
    def ledger(self):
        return {'sourceHash': 'a' * 64, 'model': 'gpt-5.4-mini', 'promptVersion': 'subtitle-zh-v1',
                'calls': [{'state': 'settled', 'applied': True, 'charged': 0.01}]}

    def test_only_verified_new_applied_progress_can_resume_at_normal_bound(self):
        self.assertTrue(hasattr(worker, 'translation_exit'), 'explicit translation exit classification is required')
        result = SimpleNamespace(returncode=1, stderr=b'Error: SUBTITLE_RUN_BOUND_REACHED')
        with self.assertRaises(worker.RunBound):
            worker.translation_exit(result, self.ledger(), 'a' * 64, 0)

    def test_uncertain_unapplied_identity_mismatch_and_no_new_progress_stay_failed(self):
        self.assertTrue(hasattr(worker, 'translation_exit'))
        result = SimpleNamespace(returncode=1, stderr=b'Error: SUBTITLE_RUN_BOUND_REACHED')
        cases = []
        for changes in ({'sourceHash': 'b' * 64}, {'model': 'other'}, {'promptVersion': 'other'},
                        {'calls': [{'state': 'pending'}]},
                        {'calls': [{'state': 'settled', 'applied': False, 'charged': 0.01}]},
                        {'calls': [{'state': 'settled', 'applied': True, 'charged': None}]}):
            cases.append(({**self.ledger(), **changes}, 0))
        cases.append((self.ledger(), 1))
        for ledger, previous in cases:
            with self.subTest(ledger=ledger, previous=previous):
                with self.assertRaisesRegex(ValueError, 'TRANSLATION_STOPPED_REVIEW_LEDGER'):
                    worker.translation_exit(result, ledger, 'a' * 64, previous)
        with self.assertRaisesRegex(ValueError, 'TRANSLATION_STOPPED_REVIEW_LEDGER'):
            worker.translation_exit(SimpleNamespace(returncode=1, stderr=b'unknown provider failure'), self.ledger(), 'a' * 64, 0)

    def test_normal_bound_requeues_with_progress_preserved_and_no_money_limit_change(self):
        self.assertTrue(hasattr(worker, 'RunBound'))
        job = {'videoSha256': 'a' * 64}
        with patch.object(worker, 'process_job', side_effect=worker.RunBound()), patch.object(worker, 'update_job') as update:
            result = worker.run_job(Path('.'), job, Path('.'), Path('.'), 60)
        self.assertEqual(result, 'run-bound')
        self.assertEqual(update.call_args.args[2:4], ('pending', 'SUBTITLE_RUN_BOUND'))
        script = Path(__file__).parents[1] / 'recording-subtitles.ts'
        text = script.read_text()
        self.assertIn('SUBTITLE_RUN_BOUND_REACHED', text)
        self.assertIn('maxUsd>1', text)

    def test_quota_reset_timer_only_targets_the_existing_bounded_worker(self):
        timer = Path(__file__).parents[2] / 'deploy/course-subtitle-budget-resume.timer'
        self.assertTrue(timer.exists(), 'quota reset must have an actual future wake source')
        text = timer.read_text()
        self.assertIn('OnCalendar=*-*-* 00:05:00 UTC', text)
        self.assertIn('Unit=course-subtitle-worker.service', text)
        self.assertIn('Persistent=true', text)
