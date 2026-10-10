import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('cleanup', Path(__file__).resolve().parents[1] / 'scripts/cleanup-legacy-homebridge-setup.py')
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'homebridge'
        self.base.mkdir()
        self.system = self.root / 'systemd'
        self.system.mkdir()
        self.cron = self.root / 'cron'
        self.cron.mkdir()
        self.old = self.base / 'roborockPauseSchedules'
        self.controller = self.old / 'controller'
        self.controller.mkdir(parents=True)
        self.state_path = self.controller / 'downtown-pause-state.json'
        self.state = {'version': 1, 'vacuumId': 'downtown', 'sessionId': 'session', 'pauseActive': False}
        self.write(self.state_path, self.state)
        self.write(self.controller / 'vacuums.json', {'version': 1, 'root': str(self.old), 'vacuums': [{'id': 'downtown'}]})
        for name in cleanup.TARGETS:
            path = self.base / name
            if name == 'config.json.bak':
                path.write_text('old backup')
            else:
                path.mkdir(exist_ok=True)
        for name in ('decent', 'rpc3control', '@mp-consulting', 'gdoorandbolt-coordinator', 'persist', 'accessories', 'matter', 'node_modules', 'backups'):
            path = self.base / name
            path.mkdir()
            (path / 'keep').write_text('active shared data')
        self.protected = {}
        for name in ('roborock.clientID', 'roborock.token.key', 'roborock.HomeData', 'roborock.RoomMappings',
                     'roborock.MqttSessionDiagnostics', 'roborock.TransportDiagnostics', 'roborock.RoborockDiagnostics',
                     'roborock-schedule-controls-65a2cab39c6e61e3.json', 'auth.json'):
            path = self.base / name
            path.write_text('private current data')
            self.protected[path] = path.read_bytes()
        self.old_switch = {'name': 'Pause All', 'on': str(self.old / 'all-vacuums-pause-on.sh'),
                           'off': str(self.old / 'all-vacuums-pause-off.sh'), 'state': str(self.old / 'all-vacuums-pause-state.sh')}
        self.other_switch = {'name': 'Other switch', 'on': '/usr/local/bin/other-on', 'off': '/usr/local/bin/other-off'}
        self.config = {'platforms': [
            {'platform': 'Script2Platform', 'on_off_switches': [self.old_switch, self.other_switch]},
            {'platform': 'RoborockVacuum', 'enableScheduleDelay': True, 'encryptedToken': 'TEST-SECRET-DO-NOT-PRINT'},
            {'platform': 'GDoorAndBoltCoordinator', 'name': 'Garage Door 2'}], 'accessories': []}
        self.write(self.base / 'config.json', self.config)
        os.chmod(self.base / 'config.json', 0o640)
        for unit in cleanup.UNITS:
            (self.system / unit).write_text('[Unit]\nDescription=Old scheduler\n')
        self.calls = []
        self.hb_active = True
        self.timer_active = True

    def write(self, path, data):
        path.write_text(json.dumps(data))

    def command(self, args, required=True, timeout=45):
        self.calls.append(args)
        output = ''
        if args[:2] == ['systemctl', 'show']:
            unit, field = args[2], args[3].split('=', 1)[1]
            if field == 'LoadState':
                output = 'loaded' if (self.system / unit).exists() else 'not-found'
            elif field == 'UnitFileState':
                output = 'enabled' if unit.endswith('.timer') else 'static'
            elif field == 'FragmentPath':
                output = str(self.system / unit) if (self.system / unit).exists() else ''
            elif field == 'DropInPaths':
                output = ' '.join(str(p) for p in (self.system / (unit + '.d')).glob('*.conf'))
            elif field == 'ActiveState':
                output = ('active' if self.hb_active else 'inactive') if unit == 'homebridge.service' else (
                    'active' if unit.endswith('.timer') and self.timer_active else 'inactive')
        elif args == ['hb-service', 'stop']:
            self.hb_active = False
        elif args == ['hb-service', 'start']:
            self.hb_active = True
        elif args[:2] == ['systemctl', 'stop']:
            self.timer_active = False
        return subprocess.CompletedProcess(args, 0, output + '\n' if output else '', '')

    @contextlib.contextmanager
    def environment(self, apply=True):
        with patch.object(cleanup, 'BASE', self.base), patch.object(cleanup, 'check_source'), \
             patch.object(cleanup, 'external_roots', return_value=([self.system], [self.system, self.cron])), \
             patch.object(cleanup, 'command', side_effect=self.command), \
             patch.object(cleanup.shutil, 'which', return_value='/usr/bin/mock'), \
             patch.object(cleanup.os, 'geteuid', return_value=0), \
             patch('sys.argv', ['cleanup', '--apply'] if apply else ['cleanup']):
            yield

    def assert_preserved(self):
        for path, payload in self.protected.items():
            self.assertEqual(path.read_bytes(), payload)
        for name in ('decent', 'rpc3control', '@mp-consulting', 'gdoorandbolt-coordinator', 'persist', 'accessories', 'matter', 'node_modules', 'backups'):
            self.assertEqual((self.base / name / 'keep').read_text(), 'active shared data')

    def test_full_cleanup_removes_only_allowlist_and_legacy_config(self):
        dropin = self.system / (cleanup.UNITS[0] + '.d')
        dropin.mkdir()
        (dropin / 'override.conf').write_text('[Timer]\nAccuracySec=5s\n')
        wants = self.system / 'timers.target.wants'
        wants.mkdir()
        (wants / cleanup.UNITS[0]).symlink_to(self.system / cleanup.UNITS[0])
        with self.environment():
            cleanup.main()
        self.assertTrue(self.hb_active)
        for name in cleanup.TARGETS:
            self.assertFalse((self.base / name).exists(), name)
        self.assertFalse(dropin.exists())
        self.assertFalse(list(wants.iterdir()))
        updated = cleanup.load_json(self.base / 'config.json')
        self.assertEqual(updated['platforms'][0]['on_off_switches'], [self.other_switch])
        self.assertEqual(updated['platforms'][1:], self.config['platforms'][1:])
        self.assertEqual(stat.S_IMODE((self.base / 'config.json').stat().st_mode), 0o640)
        self.assert_preserved()

    def test_dry_run_changes_nothing(self):
        before = (self.base / 'config.json').read_bytes()
        with self.environment(apply=False):
            cleanup.main()
        self.assertEqual(self.calls, [])
        self.assertEqual((self.base / 'config.json').read_bytes(), before)
        self.assertTrue(all((self.base / name).exists() for name in cleanup.TARGETS))

    def test_active_pause_blocks_before_stopping_services(self):
        self.state['pauseActive'] = True
        self.write(self.state_path, self.state)
        with self.environment(), self.assertRaisesRegex(cleanup.Refusal, 'still active'):
            cleanup.main()
        self.assertEqual(self.calls, [])
        self.assertTrue(self.old.exists())

    def test_pending_activation_blocks(self):
        self.state['pendingActivation'] = True
        self.write(self.state_path, self.state)
        with self.assertRaises(cleanup.Refusal):
            cleanup.check_old_state(self.base)

    def test_unfinished_restore_blocks(self):
        self.state['operation'] = {'phase': 'settling', 'desiredPause': False}
        self.write(self.state_path, self.state)
        with self.assertRaisesRegex(cleanup.Refusal, 'unresolved'):
            cleanup.check_old_state(self.base)

    def test_completed_restore_archive_is_allowed_but_mismatch_blocks(self):
        operation = {'version': 1, 'operationId': 'restored', 'phase': 'complete', 'desiredPause': False, 'auditOnly': True}
        self.state['operation'] = operation
        self.write(self.state_path, self.state)
        snapshot = {'version': 3, 'vacuumId': 'downtown', 'sessionId': 'session', 'reconciliation': operation}
        path = self.controller / 'downtown-pause-snapshot.json'
        self.write(path, snapshot)
        cleanup.check_old_state(self.base)
        snapshot['sessionId'] = 'different'
        self.write(path, snapshot)
        with self.assertRaisesRegex(cleanup.Refusal, 'not a completed restore'):
            cleanup.check_old_state(self.base)

    def test_missing_state_and_external_auth_paths_block(self):
        self.state_path.unlink()
        with self.assertRaises(cleanup.Refusal):
            cleanup.check_old_state(self.base)
        self.write(self.state_path, self.state)
        registry = cleanup.load_json(self.controller / 'vacuums.json')
        registry['homebridge'] = {'tokenFile': str(self.old / '../external-token')}
        self.write(self.controller / 'vacuums.json', registry)
        with self.assertRaisesRegex(cleanup.Refusal, 'outside'):
            cleanup.check_old_state(self.base)

    def test_nonempty_lib_and_linked_target_block(self):
        (self.base / 'lib' / 'keep').write_text('not empty')
        with self.assertRaisesRegex(cleanup.Refusal, 'no longer empty'):
            cleanup.check_targets(self.base)
        (self.base / 'lib' / 'keep').unlink()
        (self.base / 'lib').rmdir()
        (self.base / 'lib').symlink_to(self.base / 'persist', target_is_directory=True)
        with self.assertRaisesRegex(cleanup.Refusal, 'linked cleanup target'):
            cleanup.check_targets(self.base)

    def test_mixed_commands_and_unknown_config_references_block(self):
        self.config['platforms'][0]['on_off_switches'][0]['off'] = '/usr/local/bin/unrelated-action'
        with self.assertRaisesRegex(cleanup.Refusal, 'Mixed'):
            cleanup.clean_config(self.config, self.base)
        self.config['platforms'][0]['on_off_switches'] = []
        self.config['platforms'][1]['customCommand'] = str(self.old / 'script.sh')
        with self.assertRaisesRegex(cleanup.Refusal, 'Other old-scheduler references'):
            cleanup.clean_config(self.config, self.base)

    def test_legacy_accessory_and_stateless_removal(self):
        self.config['accessories'] = [{'accessory': 'Script2', **self.old_switch}, {'accessory': 'Other', 'name': 'keep'}]
        self.config['platforms'][0]['stateless_switches'] = [{'name': 'old', 'command': str(self.old / 'pause.sh')}]
        updated, removed = cleanup.clean_config(self.config, self.base)
        self.assertEqual(len(removed), 3)
        self.assertEqual(updated['accessories'], [{'accessory': 'Other', 'name': 'keep'}])

    def test_unexpected_cron_and_unit_reference_are_not_deleted(self):
        path = self.cron / 'custom-job'
        path.write_text('* * * * * homebridge ' + str(self.old / 'pause.sh'))
        with self.environment(), self.assertRaisesRegex(cleanup.Refusal, 'Other startup/cron'):
            cleanup.main()
        self.assertEqual(self.calls, [])
        self.assertTrue(path.exists())

    def test_config_edit_during_stop_is_not_overwritten(self):
        original_command = self.command
        def edit(args, **kwargs):
            result = original_command(args, **kwargs)
            if args == ['hb-service', 'stop']:
                (self.base / 'config.json').write_text('{"platforms": [], "new": true}')
            return result
        self.command = edit
        with self.environment(), self.assertRaisesRegex(cleanup.Refusal, 'configuration changed'):
            cleanup.main()
        self.assertTrue(cleanup.load_json(self.base / 'config.json')['new'])
        self.assertTrue(self.hb_active)
        self.assertTrue(self.old.exists())

    def test_new_pause_after_stop_restarts_homebridge_and_preserves_all_files(self):
        original_command = self.command
        def activate(args, **kwargs):
            result = original_command(args, **kwargs)
            if args == ['hb-service', 'stop']:
                self.state['pauseActive'] = True
                self.write(self.state_path, self.state)
            return result
        self.command = activate
        with self.environment(), self.assertRaisesRegex(cleanup.Refusal, 'still active'):
            cleanup.main()
        self.assertTrue(self.hb_active)
        self.assertTrue(self.old.exists())
        self.assertEqual(cleanup.load_json(self.base / 'config.json'), self.config)

    def test_deletion_failure_keeps_retired_timers_disabled_and_restarts(self):
        with self.environment(), patch.object(cleanup, 'remove_target', side_effect=OSError('injected')), self.assertRaises(OSError):
            cleanup.main()
        self.assertTrue(self.hb_active)
        self.assertFalse(any(c[:2] == ['systemctl', 'enable'] for c in self.calls))
        self.assertEqual(cleanup.load_json(self.base / 'config.json')['platforms'][0]['on_off_switches'], [self.other_switch])
        self.assert_preserved()

    def test_failed_rollback_still_attempts_homebridge_restart(self):
        original_command = self.command
        def fail(args, **kwargs):
            if args[:2] in (['systemctl', 'disable'], ['systemctl', 'enable']):
                raise cleanup.Refusal('injected service failure')
            return original_command(args, **kwargs)
        self.command = fail
        with self.environment(), self.assertRaises(cleanup.Refusal):
            cleanup.main()
        self.assertTrue(self.hb_active)
        self.assertIn(['hb-service', 'start'], self.calls)

    def test_busy_controller_lock_blocks_deletion_and_restarts(self):
        import fcntl
        path = self.controller / 'downtown-pause.lock'
        with path.open('w') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.environment(), self.assertRaisesRegex(cleanup.Refusal, 'operation is running'):
                cleanup.main()
        self.assertTrue(self.hb_active)
        self.assertTrue(self.old.exists())
        self.assertEqual(cleanup.load_json(self.base / 'config.json'), self.config)

    def test_config_write_failure_rolls_back_and_restarts(self):
        real_write = cleanup.atomic_config
        calls = []
        def failing_write(path, payload, metadata):
            calls.append(payload)
            real_write(path, payload, metadata)
            if len(calls) == 1:
                raise OSError('injected failure after rename')
        with self.environment(), patch.object(cleanup, 'atomic_config', side_effect=failing_write), self.assertRaises(OSError):
            cleanup.main()
        self.assertEqual(cleanup.load_json(self.base / 'config.json'), self.config)
        self.assertTrue(self.old.exists())
        self.assertTrue(self.hb_active)

    def test_nested_symlink_does_not_delete_target(self):
        (self.old / 'linked-current-data').symlink_to(self.base / 'gdoorandbolt-coordinator', target_is_directory=True)
        with self.environment():
            cleanup.main()
        self.assert_preserved()

    def test_dirty_or_unpublished_source_blocks(self):
        source = self.base / 'roborockPauseSchedulesSource'
        (source / '.git').mkdir()
        result = lambda value: subprocess.CompletedProcess([], 0, value, '')
        with patch.object(cleanup, 'command', return_value=result(' M local.py\n')), self.assertRaisesRegex(cleanup.Refusal, 'local changes'):
            cleanup.check_source(self.base)
        with patch.object(cleanup, 'command', side_effect=[result(''), result('1\n')]), self.assertRaisesRegex(cleanup.Refusal, 'commits absent'):
            cleanup.check_source(self.base)

    def test_inactive_homebridge_is_not_started(self):
        self.hb_active = False
        with self.environment():
            cleanup.main()
        self.assertFalse(self.hb_active)
        self.assertNotIn(['hb-service', 'start'], self.calls)

    def test_missing_units_and_rerun_are_supported(self):
        for path in self.system.iterdir():
            path.unlink()
        with self.environment():
            cleanup.main()
            cleanup.main()
        self.assert_preserved()

    def test_output_does_not_contain_secret_values(self):
        output = io.StringIO()
        with self.environment(), contextlib.redirect_stdout(output):
            cleanup.main()
        self.assertNotIn('TEST-SECRET-DO-NOT-PRINT', output.getvalue())
        self.assertNotIn('private current data', output.getvalue())


if __name__ == '__main__':
    unittest.main()
