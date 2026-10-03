"""Scheduler search integration and finite WB retry-budget regressions."""
import copy
import unittest
from contextlib import nullcontext
from unittest.mock import patch

import scanner
import scheduling
import state
import wb


class RetryBudgetTests(unittest.TestCase):
    def test_expired_budget_starts_no_http_requests(self):
        with patch.object(wb.SESSION, "get") as get, wb.request_budget(seconds=0):
            self.assertIsNone(wb._get(wb.SEARCH))
            self.assertEqual(wb.search("платье", 1), [])
            self.assertEqual(wb.cards([1]), [])
            self.assertFalse(wb._http_ok("https://example.invalid/image"))
            self.assertIsNone(wb._fetch_photo("https://example.invalid/image"))
            get.assert_not_called()

    def test_nested_budget_cannot_extend_and_is_restored(self):
        with patch.object(wb.time, "monotonic", return_value=100):
            with wb.request_budget(seconds=20):
                self.assertEqual(wb._remaining(), 20)
                with wb.request_budget(seconds=1000):
                    self.assertEqual(wb._remaining(), 20)
                with wb.request_budget(deadline=110):
                    self.assertEqual(wb._remaining(), 10)
                self.assertEqual(wb._remaining(), 20)
            self.assertIsNone(wb._remaining())

    def test_network_failure_cannot_sleep_or_retry_past_deadline(self):
        clock = [100.0]

        def failed(*args, **kwargs):
            timeout = kwargs["timeout"]
            self.assertLessEqual(sum(timeout), 2.0)
            clock[0] += sum(timeout)
            raise wb.requests.Timeout("connection timeout")

        def advance(seconds):
            clock[0] += seconds

        with patch.object(wb.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(wb.time, "sleep", side_effect=advance), \
             patch.object(wb.SESSION, "get", side_effect=failed) as get, \
             patch.dict(wb.os.environ, {"WB_SOURCE_KEY": "unit-test-secret"}):
            with wb.request_budget(seconds=2):
                self.assertIsNone(wb._get(wb.SEARCH))
            self.assertEqual(get.call_count, 1)
            self.assertEqual(clock[0], 102)

    def test_legacy_timeout_is_unchanged_without_budget(self):
        self.assertEqual(wb._timeout(25), 25)


class ScannerRuntimeTests(unittest.TestCase):
    def test_full_single_topic_buffer_is_pruned_before_full_queue_shortcut(self):
        now = int(scanner.time.time())
        data = state._empty()
        data['queue'] = [dict(id=i+1, query='Аптечная косметика', queued_ts=now) for i in range(100)]
        with patch.object(scanner.scheduler_client, 'enabled', return_value=True), \
             patch.object(scanner.smart, 'pick_queries', return_value=[]), \
             patch.object(scanner.smart, 'pick_categories', return_value=[]), \
             patch.object(scanner.wb, 'menu', return_value=[]):
            scanner.fill_queue(data, {}, target=100)
        self.assertEqual(len(data['queue']), scanner.smart.DAILY_TOPIC_LIMIT)
        self.assertLess(len(data['queue']), 100)

    def _run(self, *, snapshot=None, request="", due=False, failure=False):
        cfg = {"schedule": dict(scheduling.DEFAULTS), "schedule_search_request": request}
        data = state._empty()
        calls = []

        def runtime(op, **values):
            calls.append((op, values))
            return (snapshot or {}) if op == "snapshot" else {"ok": True}

        def fill(data, settings, **kwargs):
            self.assertTrue(kwargs["force_scan"])
            self.assertIsNotNone(wb._remaining())
            if failure:
                raise RuntimeError("secret-url-must-not-be-in-state")
            data["meta"].update(last_scan_funnel={"found": 42, "new": 12}, last_scan_added=7,
                                last_scan_success=123)
            return 7

        with patch.object(scanner.scheduler_client, "enabled", return_value=True), \
             patch.object(scanner.scheduler_client, "refresh"), \
             patch.object(scanner.scheduler_client, "lease", return_value=nullcontext("owner")), \
             patch.object(scanner.scheduler_client, "runtime", side_effect=runtime), \
             patch.object(scanner.config, "load_settings", return_value=copy.deepcopy(cfg)), \
             patch.object(scanner.config, "apply"), patch.object(scanner.state, "load", return_value=data), \
             patch.object(scanner.deal_queue, "load", return_value=[]), \
             patch.object(scanner.scheduling, "search_due", return_value=due), \
             patch.object(scanner, "fill_queue", side_effect=fill) as fill_mock, \
             patch.object(scanner, "_persist") as persist:
            scanner.main()
        return data, calls, fill_mock.call_count, persist.call_count

    def test_scheduled_scan_uses_lease_and_reports_counts(self):
        data, calls, filled, saved = self._run(due=True)
        self.assertEqual((filled, saved), (1, 1))
        complete = next(values for op, values in calls if op == "scan_complete")
        self.assertEqual((complete["found"], complete["new"], complete["added"]), (42, 12, 7))
        self.assertEqual(complete["owner"], "owner")
        self.assertGreater(data["meta"]["last_scan_attempt"], 0)

    def test_manual_scan_consumes_request_before_running(self):
        _, calls, filled, _ = self._run(request="request-1")
        self.assertEqual(filled, 1)
        consume = next(values for op, values in calls if op == "consume")
        self.assertEqual(consume, {"kind": "search", "owner": "owner", "request_id": "request-1"})

    def test_stale_consumed_flag_does_not_disable_regular_due_scan(self):
        snapshot = {"consumed_requests": [{"kind": "search", "request_id": "old-request"}]}
        _, calls, filled, _ = self._run(snapshot=snapshot, request="old-request", due=True)
        self.assertEqual(filled, 1)
        self.assertFalse(any(op == "consume" for op, _ in calls))
        _, _, filled, saved = self._run(snapshot=snapshot, request="old-request", due=False)
        self.assertEqual((filled, saved), (0, 0))

    def test_scan_failure_does_not_leak_exception_text_or_old_counts(self):
        data, calls, filled, saved = self._run(due=True, failure=True)
        self.assertEqual((filled, saved), (1, 1))
        complete = next(values for op, values in calls if op == "scan_complete")
        self.assertEqual((complete["found"], complete["new"], complete["added"]), (0, 0, 0))
        self.assertNotIn("secret-url", str(data))
        self.assertIn("RuntimeError", complete["error"])


if __name__ == "__main__":
    unittest.main()
