#!/usr/bin/env python3
"""Timed Linux connection interruptions for manual Homebridge integration tests.

Run as a child process, never source. `check` is read-only. Other modes create
one temporary nftables table. Its blocking element expires inside the kernel,
even if this script or SSH session stops. No existing firewall rules are edited.
"""

import argparse
import datetime
import ipaddress
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid


def log(message):
    print(datetime.datetime.now().astimezone().isoformat(timespec="milliseconds"),
          message, flush=True)


def run(argv, data=None, check=True):
    result = subprocess.run(argv, input=data, text=True, capture_output=True,
                            timeout=8)
    if check and result.returncode:
        raise RuntimeError("{} failed ({}): {}".format(
            argv[0], result.returncode, result.stderr.strip()))
    return result


def homebridge_process(pid):
    """Inspect names/parent IDs only; never process arguments or environments."""
    for _ in range(12):
        try:
            name = Path("/proc/{}/comm".format(pid)).read_text().strip().lower()
            if "homebridge" in name:
                return True
            status = Path("/proc/{}/status".format(pid)).read_text()
            parent = re.search(r"^PPid:\s+(\d+)", status, re.M)
            if not parent or int(parent.group(1)) <= 1:
                return False
            pid = int(parent.group(1))
        except (OSError, ValueError):
            return False
    return False


def endpoint(text):
    address, port = text.rsplit(":", 1)
    return str(ipaddress.ip_address(address.strip("[]"))), int(port)


def discover():
    result = run(["ss", "-Hntp", "state", "established"])
    candidates = []
    for line in result.stdout.splitlines():
        fields = line.split()
        offset = 0 if fields and fields[0].isdigit() else 1
        if len(fields) < offset + 4:
            continue
        try:
            local, local_port = endpoint(fields[offset + 2])
            peer, port = endpoint(fields[offset + 3])
        except ValueError:
            continue
        if port not in (1883, 8883) or not ipaddress.ip_address(peer).is_global:
            continue
        pids = sorted(set(int(value) for value in re.findall(r"pid=(\d+)", line)))
        for pid in pids:
            if homebridge_process(pid):
                try:
                    status = Path("/proc/{}/status".format(pid)).read_text()
                    # Socket ownership follows the filesystem UID.
                    uid = int(re.search(r"^Uid:\s+\d+\s+\d+\s+\d+\s+(\d+)",
                                        status, re.M).group(1))
                    candidates.append((pid, uid, local, local_port, peer, port))
                except (OSError, AttributeError, ValueError):
                    pass
                break
    for pid, uid, local, local_port, peer, port in candidates:
        log("Homebridge MQTT candidate: PID={} UID={} peer={}:{}".format(
            pid, uid, peer, port))
    if len(candidates) != 1:
        raise RuntimeError("Found {} public Homebridge MQTT connections; need exactly one. "
                           "No connection was interrupted. Return this output for review."
                           .format(len(candidates)))
    return candidates[0]


def rules(table, uid, port, seconds):
    return "\n".join([
        "add table inet " + table,
        "add set inet " + table + " blocked { type inet_service; flags timeout; }",
        "add chain inet " + table +
        " output { type filter hook output priority -10; policy accept; }",
        "add rule inet " + table + " output meta skuid " + str(uid) +
        " tcp dport @blocked counter reject with tcp reset",
        "add element inet " + table + " blocked { " + str(port) +
        " timeout " + str(seconds) + "s }",
        "",
    ])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "mqtt", "https"))
    parser.add_argument("seconds", type=int, nargs="?", default=30)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError("Run with sudo so socket ownership can be checked.")
    if not 3 <= args.seconds <= 60:
        raise RuntimeError("Duration must be between 3 and 60 seconds.")
    for command in ("ss", "nft"):
        if not shutil.which(command):
            raise RuntimeError("Missing '{}'. No settings changed; return this output."
                               .format(command))
    pid, uid, local, local_port, peer, mqtt_port = discover()
    port = 443 if args.mode == "https" else mqtt_port
    table = "rr_live_" + uuid.uuid4().hex[:12]
    text = rules(table, uid, port, args.seconds)
    run(["nft", "--check", "-f", "-"], text)
    if args.mode == "check":
        log("READ-ONLY CHECK PASSED. No firewall rules or connections changed.")
        return
    log("Will interrupt outbound TCP destination port {} for Linux UID {} for {}s."
        .format(port, uid, args.seconds))
    log("Other plugins/processes using this UID and port are affected too.")
    log("Open Apple Home and the Homebridge log; interruption starts in 5 seconds.")
    time.sleep(5)
    # Refuse to target a stale socket or a different process after the countdown.
    if discover() != (pid, uid, local, local_port, peer, mqtt_port):
        raise RuntimeError("MQTT connection changed during preparation; rerun.")
    created = False
    try:
        # A single nft transaction is atomic; failed validation installs nothing.
        run(["nft", "-f", "-"], text)
        created = True
        deadline = time.monotonic() + args.seconds
        log("BLOCK ACTIVE; kernel expiry is {} seconds. Table={}".format(
            args.seconds, table))
        if args.mode == "mqtt":
            family = "-6" if ":" in peer else "-4"
            selection = [family, "state", "established", "src", local,
                         "sport", "=", str(local_port), "dst", peer,
                         "dport", "=", str(mqtt_port)]
            killed = run(["ss", "-HntK"] + selection)
            remaining = run(["ss", "-Hnt"] + selection)
            if remaining.stdout.strip() or not killed.stdout.strip():
                raise RuntimeError("Could not verify the selected MQTT socket was closed; "
                                   "this attempt is invalid.")
            log("MQTT SOCKET CLOSED. Confirm Roborock disconnect in its log; TAP NOW.")
        else:
            log("HTTPS BLOCKED. TAP THE ROUTINE NOW.")
        while time.monotonic() < deadline:
            time.sleep(min(0.2, max(0, deadline - time.monotonic())))
        log("TIMED BLOCK EXPIRED. Watch the plugin log for actual recovery.")
    finally:
        if created:
            try:
                result = run(["nft", "delete", "table", "inet", table], check=False)
                if result.returncode:
                    log("Cleanup failed; the blocking element still expires automatically. "
                        "Return this output. Table=" + table)
                else:
                    log("Temporary firewall table removed.")
            except (OSError, subprocess.TimeoutExpired) as error:
                log("Cleanup error {}; blocking element expires automatically. Table={}"
                    .format(type(error).__name__, table))


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise KeyboardInterrupt

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        log("Interrupted; no test result recorded.")
        sys.exit(130)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        log("STOP: " + str(error))
        sys.exit(1)
