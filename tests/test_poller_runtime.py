"""The Telegram consumer must survive an unavailable settings database."""
import unittest
from unittest.mock import patch

import poller
import state


class StopPolling(Exception):
    pass


class PollerAvailabilityTests(unittest.TestCase):
    def test_initial_d1_failure_does_not_disable_telegram_consumer(self):
        with patch.object(poller.config, 'TG_BOT_TOKEN', 'test-only'), \
                patch.object(poller.config, 'TG_ADMIN_ID', '11'), \
                patch.object(poller.config, 'load_settings', return_value={}), \
                patch.object(poller.config, 'apply'), \
                patch.object(poller.scheduler_client, 'enabled', return_value=True), \
                patch.object(poller.scheduler_client, 'refresh', side_effect=RuntimeError('Scheduler HTTP 503')) as refresh, \
                patch.object(poller.state, 'load', return_value=state._empty()), \
                patch.object(poller.deal_queue, 'load', return_value=[]), \
                patch.object(poller.tg, 'set_commands'), \
                patch.object(poller, '_maybe_daily_digest'), \
                patch.object(poller, '_maybe_week_digest'), \
                patch.object(poller.time, 'time', return_value=100), \
                patch.object(poller, 'LIFETIME', 61), \
                patch.object(poller.admin, 'poll', side_effect=StopPolling) as consume:
            with self.assertRaises(StopPolling):
                poller.main()
            consume.assert_called_once()
            refresh.assert_called_once()  # No hot retry on each getUpdates loop.


if __name__ == '__main__':
    unittest.main()
