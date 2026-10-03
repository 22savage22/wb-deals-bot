import os
import unittest
from unittest.mock import patch

from miniapp import native_bootstrap as migration


class NativeBootstrapTests(unittest.TestCase):
    def test_configure_changes_only_interval_and_uses_revision(self):
        schedule = {'enabled': True, 'paused': False, 'timezone': 'Europe/Moscow',
                    'quiet_enabled': True, 'post_interval_minutes': 30}
        with patch.dict(os.environ, {'NATIVE_ACTION': 'configure', 'NATIVE_POST_INTERVAL': '10'}), \
             patch.object(migration.client, 'api', side_effect=[
                 {'schedule': schedule, 'revision': 7}, {'ok': True}]) as api, \
             patch('builtins.print'):
            migration.main()
        self.assertEqual(api.call_args.args, ('config', 'PUT', {
            'schedule': {**schedule, 'post_interval_minutes': 10}, 'revision': 7}))
        self.assertEqual(schedule['post_interval_minutes'], 30)

    def test_configure_reloads_after_conflict_preserving_new_settings(self):
        with patch.dict(os.environ, {'NATIVE_ACTION': 'configure', 'NATIVE_POST_INTERVAL': '10'}), \
             patch.object(migration.client, 'api', side_effect=[
                 {'schedule': {'paused': False}, 'revision': 1}, {'conflict': True},
                 {'schedule': {'paused': True}, 'revision': 2}, {'ok': True}]) as api, \
             patch('builtins.print'):
            migration.main()
        self.assertTrue(api.call_args.args[2]['schedule']['paused'])
        self.assertEqual(api.call_args.args[2]['revision'], 2)

    def test_bad_interval_cannot_change_production(self):
        with patch.dict(os.environ, {'NATIVE_ACTION': 'configure', 'NATIVE_POST_INTERVAL': '0'}), \
             patch.object(migration.client, 'api') as api:
            with self.assertRaises(ValueError):
                migration.main()
        api.assert_not_called()

    def test_check_is_read_only_and_reports_current_configuration(self):
        with patch.dict(os.environ, {'NATIVE_ACTION': 'check'}), \
             patch.object(migration.client, 'api', side_effect=[
                 {'dry_run': True, 'telegram_posts_created': 0},
                 {'schedule': {'enabled': True}, 'status': {'queue_size': 12}}]) as api, \
             patch('builtins.print'):
            migration.main()
        self.assertEqual([c.args for c in api.call_args_list], [('check',), ('config',)])


if __name__ == '__main__':
    unittest.main()
