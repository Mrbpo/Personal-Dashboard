import base64
import hashlib
import hmac
import importlib.util
import json
import unittest
from datetime import datetime
from pathlib import Path

spec = importlib.util.spec_from_file_location('refresh_creds', Path(__file__).with_name('refresh-playback-credentials.py'))
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class PlayerCredentialTests(unittest.TestCase):
    def test_fixed_read_only_prefix_claims_signature_and_24_hour_expiry(self):
        parent = {'S3_ENDPOINT': 'https://' + 'a' * 32 + '.r2.cloudflarestorage.com', 'S3_BUCKET': 'test-only',
                  'AWS_ACCESS_KEY_ID': 'TESTONLY', 'AWS_SECRET_ACCESS_KEY': 'synthetic-parent-secret'}
        credentials = refresh.derive_credentials(parent, now=1800000000)
        token = base64.b64decode(credentials['sessionToken']).decode().removeprefix('jwt/')
        header, claims, signature = token.split('.')
        decoded = json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4)))
        self.assertEqual(set(decoded['actions']), {'GetObject', 'HeadObject'})
        self.assertEqual(decoded['paths'], {'prefixPaths': ['course-recordings/'], 'objectPaths': []})
        self.assertEqual(decoded['bucket'], 'test-only')
        self.assertNotIn('scope', decoded)
        self.assertEqual(decoded['sub'], 'a' * 32)
        self.assertEqual(decoded['iss'], 'TESTONLY')
        self.assertEqual(decoded['aud'], 'a' * 32 + '.r2.cloudflarestorage.com')
        self.assertEqual(decoded['exp'] - decoded['iat'], 86400)
        self.assertEqual(datetime.fromisoformat(credentials['expiresAt']).timestamp(), decoded['exp'])
        expected = hmac.new(parent['AWS_SECRET_ACCESS_KEY'].encode(), (header + '.' + claims).encode(), hashlib.sha256).digest()
        self.assertEqual(base64.urlsafe_b64decode(signature + '=' * (-len(signature) % 4)), expected)
        self.assertEqual(credentials['secretAccessKey'], hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn(parent['AWS_SECRET_ACCESS_KEY'], json.dumps(credentials))
        with self.assertRaises(ValueError):
            refresh.derive_credentials({**parent, 'AWS_SESSION_TOKEN': 'temporary-parent-not-supported'})


if __name__ == '__main__':
    unittest.main()
