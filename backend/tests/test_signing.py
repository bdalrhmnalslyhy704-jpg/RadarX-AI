import hashlib
import hmac
import unittest
from urllib.parse import urlencode


class BinanceSigningTests(unittest.TestCase):
    def test_hmac_sha256_signature(self):
        params = {
            "symbol": "BTCUSDT",
            "side": "BUY",
            "type": "LIMIT",
            "timestamp": 123456789,
        }
        query = urlencode(params)
        signature = hmac.new(b"secret", query.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(len(signature), 64)
        self.assertTrue(all(ch in "0123456789abcdef" for ch in signature))


if __name__ == "__main__":
    unittest.main()
