#!/usr/bin/env python3
"""Inspect existing schedule observations; never connect to or command a robot.

Only selected device fields and schedule payloads reach the shareable report.
Credentials, local keys, serials, and unrelated log lines are not exported.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
DISCOVERY = re.compile(r"Schedule discovery for ([^\s:]+): type=array, value=")
PROBE = re.compile(r"GET user/(scene/device|devices)/([^/\s]+)(/jobs)? answered: ")
SECRET = re.compile(r"password|token|secret|local.?key|authorization|cookie|rriot|client.?id|serial|mac|ssid|bssid|email|url|host|^ip$", re.I)
CRON = re.compile(r"[\d*/?,\-]+(?:\s+[\d*/?,\-]+){4,6}")
ZONE = re.compile(r"(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)/[A-Za-z_+\-/0-9]+")
METHOD = re.compile(r"(?:app_|get_|set_|start_|stop_|resume_)[a-z_0-9]+")
WORDS = {"on", "off", "NORMAL", "TIMER", "WORKFLOW", "UTC", "GMT", "once", "daily"}
MAX_TAIL = 16 * 1024 * 1024


def alias(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:12]


def safe_shape(value, depth=0):
    """Keep numeric task settings, cron, timezone and method; mask other strings."""
    if depth > 20:
        return "<depth limit>"
    if isinstance(value, dict):
        return {str(k): ("<redacted>" if SECRET.search(str(k)) else safe_shape(v, depth + 1))
                for k, v in value.items()}
    if isinstance(value, list):
        return [safe_shape(v, depth + 1) for v in value]
    if not isinstance(value, str):
        return value
    if value[:1] in ("{", "["):
        try:
            return {"jsonString": safe_shape(json.loads(value), depth + 1)}
        except (ValueError, TypeError):
            return "<unparseable JSON string; possibly compacted by upstream logging>"
    if value in WORDS or CRON.fullmatch(value) or ZONE.fullmatch(value) or METHOD.fullmatch(value):
        return value
    if re.fullmatch(r"\d{1,18}", value):
        return value
    return "<string>"


def read_state(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("State is not an object")
    data = data.get("val", data)
    return json.loads(data) if isinstance(data, str) else data


def devices_from(home):
    products = {str(p.get("id")): p for p in home.get("products", []) if isinstance(p, dict)}
    devices = {}
    for collection in ("devices", "receivedDevices"):
        for device in home.get(collection, []) or []:
            if not isinstance(device, dict) or not device.get("duid"):
                continue
            product = products.get(str(device.get("productId")), {})
            model = next((v for v in (device.get("model"), product.get("model"))
                          if isinstance(v, str) and re.fullmatch(r"roborock\.[\w.\-]+", v)), "unknown")
            devices[str(device["duid"])] = {
                "robot": str(device.get("name") or "Unnamed robot")[:120],
                "model": model,
                "robotRef": alias(device["duid"]),
            }
    return devices


def parse_line(message, source, observed_at=None):
    message = ANSI.sub("", message)
    match = DISCOVERY.search(message)
    kind = "serverTimer"
    if match:
        duid = match.group(1)
    else:
        match = PROBE.search(message)
        if not match:
            return None
        duid = match.group(2)
        kind = "cloudScene" if match.group(1) == "scene/device" else "cloudJobs"
    try:
        payload, _ = json.JSONDecoder().raw_decode(message[match.end():].lstrip())
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, list):
        return None
    return duid, kind, {
        "source": source,
        "observedAt": observed_at,
        "payload": payload,
        "upstreamMayHaveCompactedPayload": kind != "serverTimer",
    }


def journal_records(service, since, notes):
    try:
        result = subprocess.run(
            ["journalctl", "--unit", service, "--since", since, "--lines", "20000",
             "--output", "json", "--no-pager"],
            capture_output=True, text=True, timeout=25, check=False,
        )
        if result.returncode:
            notes.append("Journal unavailable; tried bounded Homebridge log tails instead.")
            return
        for line in result.stdout.splitlines():
            try:
                row = json.loads(line)
                message = row.get("MESSAGE")
                if not isinstance(message, str):
                    continue
                timestamp = row.get("__REALTIME_TIMESTAMP")
                stamp = dt.datetime.fromtimestamp(int(timestamp) / 1_000_000, dt.timezone.utc).isoformat() if timestamp else None
                record = parse_line(message, "system journal", stamp)
                if record:
                    yield record
            except (ValueError, TypeError, OverflowError):
                continue
    except (OSError, subprocess.TimeoutExpired):
        notes.append("Journal unavailable or timed out; tried bounded Homebridge log tails instead.")


def file_records(storage, notes):
    # Oldest rotation first. Every file reading is identified as undated evidence.
    for path in (storage / "homebridge.log.1", storage / "homebridge.log"):
        if not path.is_file():
            continue
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                offset = max(0, handle.tell() - MAX_TAIL)
                handle.seek(offset)
                if offset:
                    handle.readline()
                content = handle.read(MAX_TAIL).decode("utf-8", errors="replace")
            for line in content.splitlines():
                record = parse_line(line, path.name + " (timestamp not interpreted)")
                if record:
                    yield record
        except OSError:
            notes.append("A Homebridge log file could not be read.")


def collect(storage, service, since):
    notes = []
    try:
        home = read_state(storage / "roborock.HomeData")
        devices = devices_from(home) if isinstance(home, dict) else {}
    except (OSError, ValueError, TypeError):
        devices = {}
        notes.append("No readable device inventory at the selected Homebridge storage path.")

    observations = {}
    for duid, kind, record in file_records(storage, notes):
        observations[(duid, kind)] = record
    # Prefer timestamped journal evidence over file tails of unknown age.
    for duid, kind, record in journal_records(service, since, notes):
        observations[(duid, kind)] = record

    if not observations:
        notes.append("No complete schedule reading found. This does NOT mean the robots have no schedules. Debug discovery may not have been logged or retained.")

    report = {
        "formatVersion": 1,
        "collectedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "mode": "Offline inspection of existing observations; no network, login, service changes, or robot commands",
        "evidenceLimit": "Historical readings only. They identify payload shape; they do not prove current state, time-edit support, or restoration behavior.",
        "robots": [],
        "notes": notes,
    }
    for duid in sorted(set(devices) | {key[0] for key in observations}):
        device = devices.get(duid, {"robot": "Unmatched robot", "model": "unknown", "robotRef": alias(duid)})
        robot = {**device, "readings": []}
        for kind in ("serverTimer", "cloudScene", "cloudJobs"):
            record = observations.get((duid, kind))
            if record is None:
                continue
            entries = []
            for index, item in enumerate(record["payload"]):
                if kind == "serverTimer" and isinstance(item, list) and len(item) >= 2:
                    entries.append({
                        "scheduleRef": alias(item[0]),
                        "enabled": item[1] if item[1] in ("on", "off") else "unknown",
                        "definition": safe_shape(item[2:]),
                    })
                else:
                    entries.append({"entry": index + 1, "structure": safe_shape(item)})
            robot["readings"].append({
                "kind": kind, "source": record["source"], "observedAt": record["observedAt"],
                "upstreamMayHaveCompactedPayload": record["upstreamMayHaveCompactedPayload"],
                "entryCount": len(entries), "entries": entries,
            })
        if not robot["readings"]:
            robot["note"] = "No captured schedule definition for this robot; absence is not an empty schedule list."
        report["robots"].append(robot)
    return report


def write_outputs(output, report):
    output = output.expanduser().absolute()
    # A new private directory avoids overwriting any prior capture.
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    with (output / "shareable-report.json").open("x", encoding="utf-8") as handle:
        os.chmod(handle.fileno(), 0o600)
        json.dump(report, handle, indent=2, ensure_ascii=True)
        handle.write("\n")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--storage", type=Path, default=Path("/var/lib/homebridge"))
    parser.add_argument("--service", default="homebridge")
    parser.add_argument("--since", default="24 hours ago")
    parser.add_argument("--output", type=Path, required=True, help="New output directory under an existing parent")
    args = parser.parse_args()
    report = collect(args.storage, args.service, args.since)
    output = write_outputs(args.output, report)
    print("===== START: SHAREABLE SCHEDULE TIME REPORT =====")
    print(json.dumps(report, indent=2, ensure_ascii=True))
    print("===== STOP: SHAREABLE SCHEDULE TIME REPORT =====")
    print("Shareable report: " + str(output / "shareable-report.json"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, TypeError) as error:
        print("Diagnostic stopped (" + type(error).__name__ + "). Check the storage path, permissions, and that the output directory is new.", file=sys.stderr)
        sys.exit(1)
