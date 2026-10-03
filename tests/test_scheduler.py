import os
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import scheduler
import scheduling


class SchedulerTests(unittest.TestCase):
    def test_discarded_queue_ids_are_not_resurrected_by_remote_merge(self):
        settings = {'schedule': dict(scheduling.DEFAULTS), '_schedule_revision': 1}
        data = {'posted': {}, 'recent': [], 'meta': {}, 'queue': []}
        def publish(data, *args, **kwargs):
            data['queue'] = [data['queue'][1]]
            data['meta']['last_run'] = int(time.time())
            return 0
        with patch.object(scheduler.config, 'load_settings', return_value=settings), \
             patch.object(scheduler.config, 'apply'), patch.object(scheduler.client, 'refresh'), \
             patch.object(scheduler.state, 'load', return_value=data), \
             patch.object(scheduler.deal_queue, 'load', return_value=[{'id': 1}, {'id': 2}]), \
             patch.object(scheduler.client, 'runtime', return_value={}), \
             patch.object(scheduler.client, 'api'), patch.object(scheduler.scheduling, 'post_due', return_value=True), \
             patch.object(scheduler.bot, 'run_posting', side_effect=publish), \
             patch.object(scheduler.deal_queue, 'save', side_effect=lambda p,q,s:q), \
             patch.object(scheduler.bot, 'commit_queue') as commit, \
             patch.object(scheduler.bot, 'commit_state'), patch.object(scheduler.state, 'save'):
            scheduler.tick(dispatch_search=False)
        self.assertEqual(commit.call_args.args[3], {1})

    def test_cloudflare_job_exits_after_one_tick_without_search_dispatch_or_sleep(self):
        with patch.object(scheduler.client, 'enabled', return_value=True), patch.object(scheduler, 'sync_git') as sync, patch.object(scheduler, 'tick') as tick, patch.object(scheduler.time, 'sleep') as sleep, patch.object(sys, 'argv', ['scheduler.py', '--once']):
            scheduler.main()
            sync.assert_called_once()
            tick.assert_called_once()
            self.assertFalse(tick.call_args.kwargs['dispatch_search'])
            sleep.assert_not_called()
    def test_dispatch_skips_matching_queued_run_and_excludes_itself(self):
        with patch.dict(os.environ, {'GITHUB_RUN_ID': '1'}), patch.object(scheduler, 'github') as api:
            api.return_value = {'workflow_runs': [{'id': 1, 'status': 'in_progress'}, {'id': 2, 'status': 'queued'}]}
            self.assertFalse(scheduler.dispatch_if_idle('deals.yml'))
            self.assertEqual(api.call_count, 1)
            api.reset_mock()
            api.return_value = {'workflow_runs': [{'id': 1, 'status': 'in_progress'}]}
            self.assertTrue(scheduler.dispatch_if_idle('deals.yml'))
            self.assertEqual(api.call_args.args[1], 'POST')

    def test_remote_refresh_never_writes_or_resets_checkout(self):
        with patch.object(scheduler.subprocess, 'run') as run, patch.object(scheduler.state, 'save') as save:
            run.return_value.returncode = 0
            scheduler.sync_git()
            run.assert_called_once()
            self.assertEqual(run.call_args.args[0], ['git', 'fetch', 'origin', 'main'])
            self.assertLessEqual(run.call_args.kwargs['timeout'], 30)
            save.assert_not_called()

    def test_pause_keeps_search_independent_and_reports_status(self):
        now = int(time.time())
        settings = {'schedule': {**scheduling.DEFAULTS, 'paused': True}, '_schedule_revision': 1}
        data = {'posted': {}, 'recent': [], 'meta': {}, 'queue': []}
        with patch.object(scheduler.config, 'load_settings', return_value=settings), \
             patch.object(scheduler.config, 'apply'), patch.object(scheduler.state, 'load', return_value=data), \
             patch.object(scheduler.deal_queue, 'load', return_value=[]), \
             patch.object(scheduler.client, 'refresh', side_effect=lambda s: s), \
             patch.object(scheduler.client, 'runtime', return_value={'posts': [], 'consumed_requests': []}), \
             patch.object(scheduler.client, 'api') as api, \
             patch.object(scheduler.bot, 'run_posting') as post, \
             patch.object(scheduler, 'dispatch_if_idle') as dispatch:
            status = scheduler.tick()
            post.assert_not_called()
            dispatch.assert_called_once_with('scanner.yml')
            self.assertEqual(status['next_posts'], [])
            self.assertGreaterEqual(status['next_search'], now)
            api.assert_called_once()

    def test_consumed_force_does_not_repeat_send(self):
        now = int(time.time())
        settings = {'schedule': scheduling.normalize({}), '_schedule_revision': 1}
        data = {'posted': {1: now}, 'recent': [{'pid': 1, 'ts': now}], 'meta': {}, 'queue': []}
        snapshot = {'posts': [{'pid': 1, 'ts': now}], 'consumed_requests': [{'kind': 'post', 'request_id': 'force1'}], 'scan_running': True}
        with patch.object(scheduler.config, 'load_settings', return_value=settings), \
             patch.object(scheduler.config, 'apply'), patch.object(scheduler.state, 'load', return_value=data), \
             patch.object(scheduler.deal_queue, 'load', return_value=[]), \
             patch.object(scheduler.client, 'refresh', side_effect=lambda s: s), \
             patch.object(scheduler.client, 'runtime', return_value=snapshot), \
             patch.object(scheduler.client, 'api'), patch.object(scheduler.bot, 'run_posting') as post:
            status = scheduler.tick('force1')
            post.assert_not_called()
            self.assertEqual(status['posted_today'], 1)
            self.assertEqual(status['posts_hour'], 1)


if __name__ == '__main__':
    unittest.main()
