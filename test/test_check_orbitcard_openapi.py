"""Contract checks for the standalone, read-only Open API probe."""

import hashlib
import hmac
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_orbitcard_openapi.py"
SPEC = importlib.util.spec_from_file_location("check_orbitcard_openapi", SCRIPT)
probe = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = probe
SPEC.loader.exec_module(probe)


class FakeClient:
    def __init__(self):
        self.calls = []

    def request(self, operation, body=None):
        self.calls.append((operation, body or {}))
        payloads = {
            "getAccountBalance": {"available_balance": "50.00", "total_balance": "70.00"},
            "getProductCode": {"list": [{"product_code": "p1", "min_initial_amount": "20.00"}]},
            "getSubscriptionPlans": {"enabled": True, "plans": [{"type": "gpt-plus", "name": "Plus"}]},
            "getSubscriptionCatalog": {"enabled": True, "plans": [{"type": "gpt-plus", "name": "Plus"}]},
            "getSubscriptionPaymentRegions": {"plan_type": "gpt-plus", "payment_regions": [{"code": "US", "default": True}]},
            "getCardList": {"list": [{"card_id": 42, "status": "ACTIVE", "card_number": "5555555555554444"}], "total": 1},
            "cardTransaction": {"list": [{"card_id": 42, "merchant": "private-merchant"}], "total": 1},
            "getCardFlow": {"list": [{"order_no": "private-funding"}], "total": 1},
            "getSubscriptionList": {"items": [{"status": "succeeded", "session_json": {"accessToken": "private-session"}}], "total": 1},
            "getSubscription": {"task_no": "SUB-1", "status": "succeeded", "session_json": {"accessToken": "private-session"}},
        }
        if operation == "cardDetail":
            card = {"card_id": 42, "status": "ACTIVE", "balance": "40.00", "card_number": "5555555555554444", "cvv": "123"}
            data = {"list": [card]} if "card_ids" in (body or {}) else card
        else:
            data = payloads[operation]
        return {"ok": True, "http_status": 200, "code": 0, "data": data}


class OpenApiProbeTests(unittest.TestCase):
    def test_config_reads_credentials_only_from_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "probe.json"
            path.write_text('{"base_url":"https://orbitcard.cc"}', encoding="utf-8")
            with mock.patch.dict(probe.os.environ, {
                    "ORBITCARD_API_KEY": "environment-key",
                    "ORBITCARD_API_SECRET": "environment-secret"}):
                loaded = probe.load_config(path)
                self.assertEqual(loaded["api_key"], "environment-key")
                self.assertEqual(loaded["api_secret"], "environment-secret")
                path.write_text('{"api_key":"browser-key"}', encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "只能通过环境变量"):
                    probe.load_config(path)

    def test_signature_uses_exact_ten_line_canonical_request(self):
        config = {"base_url": "https://orbitcard.cc", "api_key": "example-key", "api_secret": "example-secret"}
        client = probe.OrbitcardClient(config)
        with mock.patch.object(probe.time, "time", return_value=1700000000), mock.patch.object(
                probe.secrets, "token_urlsafe", return_value="nonce-example"):
            request = client.signed_request("getAccountBalance", {})
        canonical = "\n".join(("ORBITCARD-HMAC-SHA256-V1", "example-key", "1700000000",
                               "nonce-example", "POST", "orbitcard.cc",
                               "/api/open/v1/getAccountBalance", "", hashlib.sha256(b"{}").hexdigest(), ""))
        expected = hmac.new(b"example-secret", canonical.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(request.data, b"{}")
        self.assertEqual(request.get_header("X-signature"), expected)
        self.assertEqual(request.get_header("X-api-key"), "example-key")
        self.assertNotIn("Idempotency-key", request.headers)
        for write in ("createCard", "rechargeCard", "createSubscription", "refundCard"):
            with self.assertRaises(ValueError):
                client.signed_request(write, {})

    def test_full_probe_only_reads_and_redacts_sensitive_fields(self):
        client = FakeClient()
        config = {"base_url": "https://orbitcard.cc", "api_key": "private-key", "api_secret": "private-secret",
                  "max_cards": 20, "card_id": None, "task_no": "SUB-1", "client_order_no": ""}
        report = probe.run_checks(client, config)
        self.assertEqual(report["failed"], 0)
        self.assertEqual(report["skipped"], 0)
        self.assertTrue(all(operation in probe.READ_OPERATIONS for operation, _ in client.calls))
        self.assertEqual(next(body for operation, body in client.calls if operation == "cardDetail" and "card_ids" in body),
                         {"card_ids": [42], "reveal_sensitive": False})
        dumped = json.dumps(report)
        for secret in ("private-key", "private-secret", "private-session", "5555555555554444", "private-merchant", "private-funding", "123"):
            self.assertNotIn(secret, dumped)
        self.assertEqual(next(item for item in report["checks"] if item["operation"] == "getSubscriptionList")["summary"]["statuses"],
                         ["succeeded"])

    def test_missing_balance_and_batch_card_are_reported_as_failures(self):
        class IncompleteClient(FakeClient):
            def request(self, operation, body=None):
                if operation == "getAccountBalance":
                    return {"ok": True, "http_status": 200, "code": 0, "data": {"total_balance": "70.00"}}
                if operation == "cardDetail" and body and "card_ids" in body:
                    return {"ok": True, "http_status": 200, "code": 0, "data": {"list": []}}
                return super().request(operation, body)

        config = {"base_url": "https://orbitcard.cc", "max_cards": 20, "card_id": None,
                  "task_no": "", "client_order_no": ""}
        report = probe.run_checks(IncompleteClient(), config)
        self.assertEqual(report["failed"], 2)
        self.assertEqual(report["checks"][0]["status"], "failed")
        self.assertTrue(any(item.get("error") == "卡片详情缺项或卡 ID 归属不一致" for item in report["checks"]))


if __name__ == "__main__":
    unittest.main()
