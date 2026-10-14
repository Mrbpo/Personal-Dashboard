import tempfile
import unittest
from pathlib import Path
from archive import Sessions, archive_entry, atomic_json, historical_inventory, inventory_entry, media_host, parse_request, plan_video_formats, public_url, response_json, sha256, verified_files
from unittest.mock import patch


class ArchiveTests(unittest.TestCase):
    def test_historical_recovery_requires_complete_relations_and_fresh_identity(self):
        source = "https://example.invalid/courses/1/external_tools/2"
        common = {"courseId": "1", "channelId": "3", "sourceUrl": source, "seenAt": 1, "partnerId": 4}
        parent = {**common, "entryId": "0_parent", "parentEntryId": None}
        child = {**common, "entryId": "0_child", "parentEntryId": "0_parent", "trackRelation": {
            "method": "baseentry.list.parentEntryIdEqual", "parentEntryId": "0_parent", "childEntryId": "0_child"}}
        report = {"completedAt": 1, "scan": {"courses": ["1"], "scopeComplete": True},
            "channels": {"1:3": {"state": "verified", "totalCount": 1, "uniqueEntries": 1, "method": "kaf_native_visible_gallery_total"}},
            "entries": {"1:0_parent": parent, "1:0_child": child},
            "streams": {"1:0_parent": {"state": "verified", "childEntryIds": ["0_child"]}}}
        self.assertEqual(len(historical_inventory(report, "1", "3", source)), 2)
        report["streams"]["1:0_parent"]["childEntryIds"] = []
        with self.assertRaisesRegex(ValueError, "invalid_historical_relation"):
            historical_inventory(report, "1", "3", source)
        with patch('archive.kaltura_api', return_value={"id": "0_child", "parentEntryId": None}):
            with self.assertRaisesRegex(RuntimeError, 'historical_parent_identity_mismatch'):
                inventory_entry(None, {"entryId": "0_child", "_expectedParentEntryId": "0_parent"})

    def test_caption_pass_preserves_original_remote_and_reports_absence(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            original = {"kind": "video", "path": "original.mp4", "remote": {"state": "verified"}}
            metadata = {"files": [original], "updatedAt": 1}
            files = archive_entry(None, {"courseId": "440904", "entryId": "0_example"}, metadata,
                                  {"captions": []}, Path(directory), True, True)
            self.assertEqual(files, [original])
            self.assertEqual(metadata["captionArchive"]["state"], "unavailable")

    def test_original_policy_never_downgrades_or_exceeds_budget(self):
        original = {"format_id": "0_original", "preference": 10, "height": 1080, "filesize_approx": 1000, "url": "https://example.invalid/SECRET"}
        proxy = {"format_id": "0_proxy", "preference": 0, "height": 360, "filesize_approx": 10}
        public = {"state": "discovered", "mediaAssets": []}
        private = {"formats": [original, proxy]}
        blocked = plan_video_formats([("course:entry", {}, public, private)], 999, "original")
        self.assertEqual(blocked["missingCapacityBytes"], 1)
        self.assertEqual(private["formats"], [original, proxy])
        self.assertNotIn("url", blocked["selections"]["course:entry"])
        with self.assertRaisesRegex(RuntimeError, "no_authorized_original_format"):
            plan_video_formats([("course:entry", {}, public, {"formats": [proxy]})], 1000, "original")

    def test_canvas_cookie_auth_json_guard(self):
        class Response:
            def text(self):
                return 'while(1);{"id":440904}'
        self.assertEqual(response_json(Response())["id"], 440904)

    def test_wrong_entry_metadata_or_flavors_cannot_be_archived(self):
        with patch('archive.kaltura_api', return_value={"id": "0_wrong"}):
            with self.assertRaisesRegex(RuntimeError, 'media_identity_mismatch'):
                inventory_entry(None, {"entryId": "0_requested"})
        with patch('archive.kaltura_api', side_effect=[{"id": "0_requested"}, [{"entryId": "0_wrong"}]]):
            with self.assertRaisesRegex(RuntimeError, 'flavor_identity_mismatch'):
                inventory_entry(None, {"entryId": "0_requested"})

    def test_credentials_are_scoped_and_manifest_url_is_redacted(self):
        self.assertFalse(media_host("kaltura.com.attacker.invalid", set()))
        self.assertTrue(media_host("kaltura-quercus-prod.utoronto.ca", {"kaltura-quercus-prod.utoronto.ca"}))
        self.assertEqual(public_url("https://cdnapisec.kaltura.com/x/ks/SECRET?a=SECRET#SECRET"), "https://cdnapisec.kaltura.com/x/ks/[redacted]")
        request = parse_request("https://cdnapisec.kaltura.com/x", '{"ks":"SECRET","1":{"entryId":"0_example"}}')
        self.assertEqual(request["1"]["entryId"], "0_example")
        sessions = Sessions(set())
        class Request:
            url = "https://unrelated.invalid/api?ks=SECRET&entry_id=0_example"
            post_data = None
        sessions.observe_request(Request())
        self.assertEqual(sessions.entries, {})

    def test_restart_checks_actual_bytes_and_atomic_manifest(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            video = root / "original.mp4"
            video.write_bytes(b"original")
            record = {"files": [{"path": video.name, "sha256": sha256(video)}]}
            atomic_json(root / "manifest.json", {"entries": {"example": record}})
            self.assertTrue(verified_files(root, record))
            self.assertFalse(verified_files(root, {"files": [{"path": "../outside", "sha256": "secret"}]}))
            video.write_bytes(b"damaged")
            self.assertFalse(verified_files(root, record))
            self.assertFalse((root / "manifest.json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
