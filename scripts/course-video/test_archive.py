import tempfile
import unittest
from pathlib import Path
from archive import Sessions, atomic_json, inventory_entry, media_host, parse_request, public_url, response_json, sha256, verified_files
from unittest.mock import patch


class ArchiveTests(unittest.TestCase):
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
