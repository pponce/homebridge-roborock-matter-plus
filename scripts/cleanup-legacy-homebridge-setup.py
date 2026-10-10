#!/usr/bin/env python3
"""Remove Pedro's retired scheduler and explicitly selected old backups.

No device commands, credential output, package uninstall, or shared-cache purge.
The CLI has a fixed deletion allowlist; --apply is required for mutations.
"""
import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import tempfile
import time
from contextlib import ExitStack

BASE = Path('/var/lib/homebridge')
TARGETS = (
    'lib', 'roborockPauseSchedules', 'roborockPauseSchedulesSource',
    'roborockPauseSchedules-backups',
    'gdoorandbolt-coordinator-backup-20261008T004452Z-8321ca60',
    'config.json.bak',
)
UNITS = tuple('roborock-pause-' + stem + '.' + suffix
              for stem in ('reconcile', 'until-tomorrow')
              for suffix in ('timer', 'service'))
MARKER = re.compile(r'roborockPauseSchedules|roborock-pause-|ROBOROCK_PAUSE_|'
                    r'(?:all-vacuums|vacuum)-pause-|pause-until-tomorrow-', re.I)
COMMANDS = ('on', 'off', 'state', 'command', 'fileState')


class Refusal(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise Refusal(message)


def load_json(path):
    require(not path.is_symlink() and path.is_file(), 'Missing or linked JSON file: ' + str(path))
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        raise Refusal('Cannot read valid JSON: ' + str(path)) from None
    require(isinstance(data, dict), 'Unexpected JSON structure: ' + str(path))
    return data


def references(value):
    if isinstance(value, str):
        return bool(MARKER.search(value))
    if isinstance(value, dict):
        return any(references(v) for v in value.values())
    return isinstance(value, list) and any(references(v) for v in value)


def clean_config(original, base):
    config = copy.deepcopy(original)
    removed = []

    def owned(item, location):
        if not isinstance(item, dict):
            return False
        commands = [item[k] for k in COMMANDS if isinstance(item.get(k), str) and item[k].strip()]
        if not any(str(base / 'roborockPauseSchedules') + '/' in c for c in commands):
            return False
        require(all(str(base / 'roborockPauseSchedules') + '/' in c for c in commands),
                'Mixed old/new command paths require inspection: ' + location)
        removed.append(location)
        return True

    for index, platform in enumerate(config.get('platforms', [])):
        if not isinstance(platform, dict) or platform.get('platform') != 'Script2Platform':
            continue
        for key in ('devices', 'on_off_switches', 'stateless_switches'):
            if key in platform:
                require(isinstance(platform[key], list), 'Unexpected Script2 configuration shape.')
                platform[key] = [item for n, item in enumerate(platform[key])
                                 if not owned(item, f'platforms[{index}].{key}[{n}]')]
    if 'accessories' in config:
        config['accessories'] = [item for n, item in enumerate(config['accessories'])
                                if not (isinstance(item, dict) and item.get('accessory') in ('Script2', 'Script')
                                        and owned(item, f'accessories[{n}]'))]
    require(not references(config), 'Other old-scheduler references remain in config.json; no edits made.')
    return config, removed


def check_targets(base):
    require(base.is_dir() and not base.is_symlink(), 'Homebridge storage directory is missing or linked.')
    for name in TARGETS:
        path = base / name
        require(not path.is_symlink(), 'Refusing linked cleanup target: ' + str(path))
        if not path.exists():
            continue
        if name == 'config.json.bak':
            require(path.is_file(), 'Expected a regular config.json.bak file.')
            continue
        require(path.is_dir(), 'Expected a directory: ' + str(path))
        if name == 'lib':
            require(not any(path.iterdir()), 'lib is no longer empty; nothing has been deleted.')
        for parent, dirs, files in os.walk(path, followlinks=False):
            require(not os.path.ismount(parent), 'Mounted directory inside cleanup target: ' + parent)
            dirs[:] = [d for d in dirs if not (Path(parent) / d).is_symlink()]
    require(shutil.rmtree.avoids_symlink_attacks, 'This Python lacks protected directory deletion.')


def check_old_state(base):
    old = base / 'roborockPauseSchedules'
    if not old.exists():
        return []
    registry = load_json(old / 'controller/vacuums.json')
    require(registry.get('version') == 1 and registry.get('root', str(old)) == str(old),
            'Old registry uses an unexpected version or installation root.')
    for key, value in registry.get('homebridge', {}).items():
        if key.endswith('File'):
            require(isinstance(value, str) and Path(value).is_absolute()
                    and Path(value).resolve().is_relative_to(old.resolve()),
                    'Old authentication file is outside the selected directory; needs inspection.')
    ids = [v.get('id') for v in registry.get('vacuums', []) if isinstance(v, dict)]
    require(ids and all(isinstance(v, str) and re.fullmatch(r'[a-z0-9][a-z0-9_-]*', v) for v in ids),
            'Cannot establish the old scheduler vacuum list.')
    controller = old / 'controller'
    require(not controller.is_symlink(), 'Old controller directory is linked; needs inspection.')
    expected = {controller / (v + '-pause-state.json') for v in ids}
    actual = set(controller.glob('*-pause-state.json'))
    require(actual == expected, 'Old scheduler has missing or unlisted vacuum state files.')
    for vacuum in ids:
        path = controller / (vacuum + '-pause-state.json')
        state = load_json(path)
        require(state.get('version') == 1 and state.get('vacuumId') == vacuum
                and isinstance(state.get('sessionId'), str) and state['sessionId'],
                'Unrecognized old pause state: ' + path.name)
        require(state.get('pauseActive') is False and state.get('pendingActivation', False) is False,
                'Old pause or activation is still active: ' + path.name)
        summary = state.get('operation')
        require(summary is None or (isinstance(summary, dict) and summary.get('phase') == 'complete'
                and summary.get('desiredPause') is False), 'Old restoration is unresolved: ' + path.name)
        snapshot = controller / (vacuum + '-pause-snapshot.json')
        if not snapshot.exists():
            require(summary is None, 'Old restoration snapshot is missing: ' + snapshot.name)
        else:
            data = load_json(snapshot)
            operation = data.get('reconciliation') or {}
            require(isinstance(summary, dict) and isinstance(operation, dict)
                    and data.get('version') == 3 and data.get('vacuumId') == vacuum
                    and data.get('sessionId') == state['sessionId']
                    and operation.get('version') == 1 and operation.get('operationId')
                    and operation.get('operationId') == summary.get('operationId')
                    and operation.get('auditOnly') is True and operation.get('desiredPause') is False
                    and operation.get('phase') == 'complete',
                    'Old snapshot is not a completed restore: ' + snapshot.name)
    return ids


def command(args, required=True, timeout=45):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                                env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0'})
    except (OSError, subprocess.TimeoutExpired):
        raise Refusal('Command unavailable or timed out: ' + args[0]) from None
    require(not required or result.returncode == 0,
            'Command failed (output withheld): ' + args[0] + ', status ' + str(result.returncode))
    return result


def check_source(base):
    source = base / 'roborockPauseSchedulesSource'
    if not source.exists():
        return
    require((source / '.git').is_dir(), 'Source checkout has no normal Git metadata; needs inspection.')
    owner = pwd.getpwuid(source.stat().st_uid).pw_name
    prefix = ['runuser', '-u', owner, '--', 'git', '-c', 'core.fsmonitor=false',
              '-c', 'core.hooksPath=/dev/null', '-C', str(source)]
    require(not command(prefix + ['status', '--porcelain', '--untracked-files=all']).stdout.strip(),
            'Old source checkout has local changes or untracked files; kept intact.')
    ahead = command(prefix + ['rev-list', '--count', 'HEAD', '--not', '--remotes']).stdout.strip()
    require(ahead == '0', 'Old source has commits absent from its recorded remote branches; kept intact.')


def systemd_roots():
    return [Path(p) for p in ('/etc/systemd/system', '/run/systemd/system',
            '/usr/local/lib/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system')]


def owned_unit_path(path):
    return any(path.name == unit or path.name.startswith(unit + '.')
               or unit + '.d' in path.parts for unit in UNITS)


def scan_external(roots, system_roots):
    owned, unexpected, seen = [], [], set()
    def walk_error(error):
        raise Refusal('Cannot inspect startup directory: ' + str(error.filename))
    for root in roots:
        if not root.exists() and not root.is_symlink():
            continue
        paths = [root]
        if root.is_dir() and not root.is_symlink():
            for parent, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
                paths.extend(Path(parent) / name for name in files)
                paths.extend(Path(parent) / name for name in dirs if (Path(parent) / name).is_symlink())
        for path in paths:
            if path.is_dir() and not path.is_symlink():
                continue
            # Deduplicate /lib versus /usr/lib, but keep separate enablement links.
            key = str(path.parent.resolve() / path.name)
            if key in seen:
                continue
            seen.add(key)
            text = str(path)
            if path.is_symlink():
                text += '\n' + os.readlink(path)
            elif path.is_file():
                info = path.stat()
                if stat.S_ISREG(info.st_mode) and info.st_size <= 2 * 1024 * 1024:
                    text += '\n' + path.read_text(errors='replace')
            else:
                continue
            if not MARKER.search(text):
                continue
            if any(path.is_relative_to(r) for r in system_roots) and owned_unit_path(path):
                owned.append(path)
            elif path.parent == Path('/var/lib/systemd/timers') and path.name in {'stamp-' + u for u in UNITS}:
                owned.append(path)
            else:
                unexpected.append(str(path))
    require(not unexpected, 'Other startup/cron files reference the old scheduler; inspect: ' + ', '.join(unexpected))
    return sorted(owned)


def external_roots():
    system = systemd_roots()
    others = [Path(p) for p in ('/var/lib/systemd/timers', '/var/spool/cron',
              '/etc/init.d', '/etc/rc.local', '/etc/default', '/etc/environment',
              '/etc/sudoers.d', '/etc/logrotate.d', '/etc/tmpfiles.d',
              '/usr/local/bin', '/usr/local/sbin', '/root/.config/systemd/user')]
    others += list(Path('/etc').glob('cron*'))
    others += [p / '.config/systemd/user' for p in Path('/home').glob('*')]
    others += [BASE / '.config/systemd/user']
    return system, system + others


def atomic_config(path, payload, metadata):
    fd, temporary = tempfile.mkstemp(prefix='.cleanup-config-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            os.fchown(handle.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(handle.fileno(), stat.S_IMODE(metadata.st_mode))
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def unit_property(unit, field):
    return command(['systemctl', 'show', unit, '--property=' + field, '--value']).stdout.strip()


def remove_target(path):
    if not path.exists() and not path.is_symlink():
        return
    require(not path.is_symlink(), 'Cleanup target became a symlink: ' + str(path))
    if path.name == 'lib':
        path.rmdir()
    elif path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    print('Removed: ' + str(path), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Run with sudo.')
    config_path = BASE / 'config.json'
    check_targets(BASE)
    original_bytes = config_path.read_bytes()
    metadata = config_path.stat()
    original = load_json(config_path)
    require(config_path.read_bytes() == original_bytes, 'Homebridge configuration changed during preflight; retry.')
    updated, removed = clean_config(original, BASE)
    check_old_state(BASE)
    check_source(BASE)
    system, roots = external_roots()
    unit_files = scan_external(roots, system)
    print('Preflight passed. Exact cleanup targets:', flush=True)
    for name in TARGETS:
        print('  ' + str(BASE / name))
    for path in unit_files:
        print('  ' + str(path))
    for location in removed:
        print('  Old Script2 entry: ' + location)
    if not args.apply:
        print('Read-only check finished; use --apply to perform this cleanup.')
        return
    for executable in ('systemctl', 'hb-service'):
        require(shutil.which(executable), 'Required command missing: ' + executable)
    hb_active = unit_property('homebridge.service', 'ActiveState')
    require(hb_active in ('active', 'inactive', 'failed'), 'Homebridge is changing state; retry when settled.')
    loaded = {u: unit_property(u, 'LoadState') != 'not-found' for u in UNITS}
    inspected_files = {p.resolve() for p in unit_files}
    for unit in UNITS:
        if loaded[unit]:
            paths = [unit_property(unit, 'FragmentPath')]
            paths += unit_property(unit, 'DropInPaths').split()
            for value in paths:
                if value and value != '/dev/null':
                    path = Path(value)
                    require(not path.exists() or path.resolve() in inspected_files,
                            'Legacy unit uses an uninspected systemd file: ' + value)
    enabled = {u: unit_property(u, 'UnitFileState') if loaded[u] else '' for u in UNITS}
    active = {u: unit_property(u, 'ActiveState') if loaded[u] else 'inactive' for u in UNITS}
    require(all(enabled[u] in ('enabled', 'disabled', 'static', 'masked', '') for u in UNITS),
            'Unexpected legacy unit enablement; needs inspection.')
    restart = False
    irreversible = False
    changed = False
    timers_touched = False
    try:
        if hb_active == 'active':
            restart = True
            command(['hb-service', 'stop'])
            require(unit_property('homebridge.service', 'ActiveState') in ('inactive', 'failed'),
                    'Homebridge did not stop; cleanup cancelled.')
        timers_touched = True
        for unit in UNITS:
            if loaded[unit] and unit.endswith('.timer'):
                command(['systemctl', 'stop', unit])
        deadline = time.monotonic() + 30
        while any(unit_property(u, 'ActiveState') not in ('inactive', 'failed')
                  for u in UNITS if loaded[u] and u.endswith('.service')):
            require(time.monotonic() < deadline, 'Old scheduler service is still running; cleanup cancelled.')
            time.sleep(0.5)
        with ExitStack() as stack:
            controller = BASE / 'roborockPauseSchedules/controller'
            for path in sorted(controller.glob('*.lock')):
                require(not path.is_symlink(), 'Linked scheduler lock; cleanup cancelled.')
                handle = stack.enter_context(path.open('r+'))
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise Refusal('An old scheduler operation is running; cleanup cancelled.') from None
            require(config_path.read_bytes() == original_bytes, 'Homebridge configuration changed during preflight; retry.')
            check_targets(BASE)
            check_old_state(BASE)
            check_source(BASE)
            unit_files = scan_external(roots, system)
            for unit in UNITS:
                if loaded[unit] and enabled[unit] in ('enabled', 'disabled'):
                    command(['systemctl', 'disable', unit])
            if removed:
                changed = True
                atomic_config(config_path, (json.dumps(updated, indent=2) + '\n').encode(), metadata)
            # Every check precedes this point. From here, keep the old timers off
            # even if a filesystem operation fails; restart Homebridge in finally.
            irreversible = True
            for path in unit_files:
                if path.exists() or path.is_symlink():
                    path.unlink()
                    print('Removed systemd file: ' + str(path), flush=True)
            for root in system:
                for unit in UNITS:
                    dropin = root / (unit + '.d')
                    if dropin.is_dir() and not dropin.is_symlink():
                        dropin.rmdir()
            command(['systemctl', 'daemon-reload'])
            for unit in UNITS:
                command(['systemctl', 'reset-failed', unit], required=False)
            for name in TARGETS:
                remove_target(BASE / name)
    finally:
        try:
            if not irreversible:
                if changed:
                    atomic_config(config_path, original_bytes, metadata)
                if timers_touched:
                    for unit in UNITS:
                        if enabled[unit] == 'enabled':
                            command(['systemctl', 'enable', unit])
                        if active[unit] == 'active' and unit.endswith('.timer'):
                            command(['systemctl', 'start', unit])
        finally:
            if restart:
                result = command(['hb-service', 'start'], required=False)
                print('Homebridge start exit status: ' + str(result.returncode), flush=True)
                require(result.returncode == 0, 'Homebridge restart failed; run sudo hb-service start.')
    require(not any((BASE / name).exists() or (BASE / name).is_symlink() for name in TARGETS),
            'Some cleanup targets remain.')
    require(not references(load_json(config_path)), 'Old config references remain.')
    require(not scan_external(roots, system), 'Old systemd files remain.')
    require(all(unit_property(u, 'LoadState') == 'not-found' for u in UNITS),
            'A legacy unit is still known to systemd; inspect before continuing.')
    print('Cleanup complete. Current plugin data and excluded directories were preserved.')
    print('Shared Homebridge/system journals and general Homebridge backups were not purged.')


if __name__ == '__main__':
    try:
        main()
    except (Refusal, OSError, ValueError, KeyError, TypeError) as exc:
        # Do not print JSON content, command output, environment, or credentials.
        print('STOPPED: ' + (str(exc) if isinstance(exc, Refusal) else type(exc).__name__), flush=True)
        raise SystemExit(1)
