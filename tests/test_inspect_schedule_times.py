import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "inspect-schedule-times.py"
spec = importlib.util.spec_from_file_location("inspector", SCRIPT)
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


class InspectionTests(unittest.TestCase):
    def test_server_payload_survives_and_unrelated_text_is_ignored(self):
        payload = [["timer-123", "on", ["5 8 * * *", ["start_clean", {"segments": [16], "fan_power": 102}]]]]
        line = "\x1b[32m[Roborock] Schedule discovery for robot-secret-id: type=array, value=" + json.dumps(payload) + "\x1b[0m"
        duid, kind, record = inspector.parse_line(line, "test", "2026-10-09T20:00:00Z")
        self.assertEqual((duid, kind), ("robot-secret-id", "serverTimer"))
        self.assertEqual(record["payload"], payload)
        self.assertFalse(record["upstreamMayHaveCompactedPayload"])
        self.assertIsNone(inspector.parse_line("Authorization: Bearer private-token", "test"))
        self.assertIsNone(inspector.parse_line("Schedule discovery for robot: type=array, value=[[", "test"))

    def test_cloud_logs_are_marked_as_potentially_compacted(self):
        for route, kind in (("scene/device/robot", "cloudScene"), ("devices/robot/jobs", "cloudJobs")):
            result = inspector.parse_line("Roborock cloud schedule probe for Test — GET user/" + route + " answered: [] — the resource allows: GET, PUT", "test")
            self.assertEqual(result[1], kind)
            self.assertTrue(result[2]["upstreamMayHaveCompactedPayload"])

    def test_nested_credentials_are_not_exported(self):
        source = {"token": "secret-token", "param": json.dumps({"cron": "5 8 * * *", "timeZoneId": "America/Los_Angeles", "localKey": "secret-local-key", "unknown": "secret-unknown"})}
        value = inspector.safe_shape(source)
        rendered = json.dumps(value)
        for secret in ("secret-token", "secret-local-key", "secret-unknown"):
            self.assertNotIn(secret, rendered)
        self.assertIn("5 8 * * *", rendered)
        self.assertIn("America/Los_Angeles", rendered)

    def test_inventory_and_report_do_not_dump_home_data_or_raw_ids(self):
        with tempfile.TemporaryDirectory() as root:
            storage = Path(root)
            home = {"products": [{"id": "p", "model": "roborock.vacuum.test"}], "devices": [{"duid": "private-duid", "name": "Test robot", "productId": "p", "localKey": "private-key", "sn": "private-serial"}]}
            (storage / "roborock.HomeData").write_text(json.dumps({"val": json.dumps(home)}))
            (storage / "homebridge.log").write_text('Schedule discovery for private-duid: type=array, value=[["private-timer", "on", ["5 8 * * *", ["start_clean", ""]]]]\nUnrelated password=private-password\n')
            with patch.object(inspector, "journal_records", return_value=iter([])):
                report = inspector.collect(storage, "homebridge", "24 hours ago")
            rendered = json.dumps(report)
            for secret in ("private-duid", "private-key", "private-serial", "private-password", "private-timer"):
                self.assertNotIn(secret, rendered)
            self.assertEqual(report["robots"][0]["model"], "roborock.vacuum.test")
            self.assertEqual(report["robots"][0]["readings"][0]["entryCount"], 1)

    def test_absent_observation_is_not_reported_as_empty_schedule(self):
        with tempfile.TemporaryDirectory() as root, patch.object(inspector, "journal_records", return_value=iter([])):
            report = inspector.collect(Path(root), "homebridge", "24 hours ago")
            self.assertTrue(any("does NOT mean" in note for note in report["notes"]))

    def test_latest_empty_reading_and_journal_timestamp_are_retained(self):
        with tempfile.TemporaryDirectory() as root:
            rows = [inspector.parse_line('Schedule discovery for robot: type=array, value=[["1","on"]]', "journal", "2026-10-09T19:00:00Z"), inspector.parse_line('Schedule discovery for robot: type=array, value=[]', "journal", "2026-10-09T20:00:00Z")]
            with patch.object(inspector, "journal_records", return_value=iter(rows)):
                report = inspector.collect(Path(root), "homebridge", "24 hours ago")
            reading = report["robots"][0]["readings"][0]
            self.assertEqual(reading["entryCount"], 0)
            self.assertEqual(reading["observedAt"], "2026-10-09T20:00:00Z")

    def test_private_permissions_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "capture"
            inspector.write_outputs(output, {"ok": True})
            self.assertEqual(os.stat(output).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(output / "shareable-report.json").st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                inspector.write_outputs(output, {"ok": False})
            self.assertEqual(json.loads((output / "shareable-report.json").read_text()), {"ok": True})


if __name__ == "__main__":
    unittest.main()
