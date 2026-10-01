"""Python runner integration contracts: no real backend or Telegram requests."""
import copy
import os
import sys
import unittest
from unittest.mock import Mock, patch

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bot
import scheduler_client as client
import scheduling


class SchedulerClientTests(unittest.TestCase):
    def setUp(self):
        self.settings = {"schedule": scheduling.normalize({})}
        self.data = {"meta": {}, "recent": [], "posted": {}, "queue": []}

    def test_pause_change_before_claim_blocks_automatic_send(self):
        token = client._session.set({'owner': 'test', 'request_id': None, 'settings': self.settings, 'data': self.data, 'schedule': self.settings['schedule']})
        send = Mock()
        def refresh(s):
            s['schedule']['paused'] = True
        try:
            with patch.object(client, 'enabled', return_value=True), patch.object(client, 'refresh', side_effect=refresh), patch.object(client, 'runtime') as runtime:
                self.assertFalse(client.send_guarded(123, send))
                send.assert_not_called()
                runtime.assert_not_called()
        finally:
            client._session.reset(token)

    def test_runtime_merge_keeps_rich_post_and_counts_one_success(self):
        self.data['recent'] = [{'pid': 123, 'ts': 1000, 'title': 'Real item'}]
        client.merge_runtime(self.data, {'posts': [{'pid': 123, 'ts': 1001}], 'last_post': 1001})
        self.assertEqual(len(self.data['recent']), 1)
        self.assertEqual(self.data['recent'][0]['title'], 'Real item')
        self.assertEqual(self.data['recent'][0]['ts'], 1001)

    def config_result(self, **extra):
        return {"schedule": copy.deepcopy(self.settings["schedule"]), "revision": 5, **extra}

    def test_config_auth_uses_sync_key_and_bounded_timeout_only(self):
        response = Mock(status_code=200)
        response.json.return_value = self.config_result()
        with patch.dict(os.environ, {"MINIAPP_API_URL": "https://example.invalid/",
                                     "MINIAPP_SYNC_KEY": "dummy-test-sync",
                                     "WB_SOURCE_KEY": "different-dummy-source"}, clear=True), \
             patch.object(client.requests, "request", return_value=response) as request:
            client.refresh(self.settings)
        args, kwargs = request.call_args
        self.assertEqual(args, ("GET", "https://example.invalid/api/scheduler/config"))
        self.assertEqual(kwargs["headers"], {"Authorization": "Bearer dummy-test-sync"})
        self.assertEqual(kwargs["timeout"], (5, 12))
        self.assertEqual(self.settings["_schedule_revision"], 5)
        self.assertEqual(self.settings["_schedule_base"], self.settings["schedule"])

    def test_missing_sync_key_never_uses_source_key_or_sends_request(self):
        with patch.dict(os.environ, {"MINIAPP_API_URL": "https://example.invalid",
                                     "WB_SOURCE_KEY": "dummy-source-only"}, clear=True), \
             patch.object(client.requests, "request") as request:
            with self.assertRaisesRegex(RuntimeError, "configuration unavailable"):
                client.api("config")
        request.assert_not_called()

    def test_api_redacts_network_error_and_rejects_bad_response(self):
        env = {"MINIAPP_API_URL": "https://example.invalid", "MINIAPP_SYNC_KEY": "dummy-test-sync"}
        with patch.dict(os.environ, env, clear=True), \
             patch.object(client.requests, "request", side_effect=requests.Timeout("Bearer dummy-test-sync")):
            with self.assertRaises(RuntimeError) as error:
                client.api("config")
            self.assertEqual(str(error.exception), "Scheduler network unavailable")
        for status, result in ((401, {}), (200, [])):
            response = Mock(status_code=status)
            response.json.return_value = result
            with patch.dict(os.environ, env, clear=True), \
                 patch.object(client.requests, "request", return_value=response):
                with self.assertRaises(RuntimeError):
                    client.api("config")

    def test_cas_conflict_merges_only_local_delta_and_preserves_manual_request(self):
        baseline = scheduling.normalize({})
        self.settings.update({"_schedule_base": copy.deepcopy(baseline), "_schedule_revision": 5,
                              "schedule_post_request": "dummy-action-unique"})
        self.settings["schedule"]["post_interval_minutes"] = 15
        latest = {**baseline, "quiet_enabled": True, "search_interval_minutes": 30}
        calls = []
        def api(path, method="GET", payload=None):
            calls.append((path, method, copy.deepcopy(payload)))
            if method == "PUT" and len([x for x in calls if x[1] == "PUT"]) == 1:
                return {"conflict": True}
            if path == "action":
                return {"ok": True}
            if method == "GET" and len(calls) == 2:
                return {"schedule": latest, "revision": 6}
            return {"schedule": {**latest, "post_interval_minutes": 15}, "revision": 7}
        with patch.object(client, "api", side_effect=api):
            client.push(self.settings)
        put = [x[2] for x in calls if x[1] == "PUT"]
        self.assertEqual([p["revision"] for p in put], [5, 6])
        self.assertEqual(put[1]["schedule"]["post_interval_minutes"], 15)
        self.assertTrue(put[1]["schedule"]["quiet_enabled"])
        self.assertEqual(put[1]["schedule"]["search_interval_minutes"], 30)
        self.assertIn(("action", "POST", {"action": "post_now", "request_id": "dummy-action-unique"}), calls)
        self.assertEqual(self.settings["_schedule_revision"], 7)

    def test_persistent_cas_conflict_is_bounded_and_does_not_send_action(self):
        self.settings["_schedule_base"] = copy.deepcopy(self.settings["schedule"])
        self.settings["schedule"]["post_interval_minutes"] = 15
        self.settings["schedule_post_request"] = "dummy-action"
        def api(path, method="GET", payload=None):
            if method == "PUT":
                return {"conflict": True}
            return {"schedule": scheduling.normalize({}), "revision": 6}
        with patch.object(client, "api", side_effect=api) as request:
            with self.assertRaisesRegex(RuntimeError, "concurrently changed"):
                client.push(self.settings)
        self.assertEqual(sum(call.args[1:2] == ("PUT",) for call in request.call_args_list), 3)
        self.assertFalse(any(call.args[0] == "action" for call in request.call_args_list))

    def test_unavailable_backend_fails_closed_before_any_telegram_send(self):
        send = Mock(return_value=True)
        with patch.object(client, "enabled", return_value=True), \
             patch.object(client, "runtime", side_effect=RuntimeError("Scheduler network unavailable")):
            with self.assertRaisesRegex(RuntimeError, "network unavailable"):
                client.send_guarded(123, send)
        send.assert_not_called()

    def test_acquired_lease_released_if_configuration_refresh_fails(self):
        send = Mock(return_value=True)
        with patch.object(client, "enabled", return_value=True), \
             patch.object(client, "runtime", return_value={"ok": True}) as runtime, \
             patch.object(client, "refresh", side_effect=RuntimeError("Scheduler HTTP 401")):
            with self.assertRaisesRegex(RuntimeError, "HTTP 401"):
                client.send_guarded(123, send)
        send.assert_not_called()
        self.assertEqual([c.args[0] for c in runtime.call_args_list], ["acquire", "release"])

    def test_concurrent_lease_rejection_never_refreshes_or_sends(self):
        send = Mock(return_value=True)
        with patch.object(client, "enabled", return_value=True), \
             patch.object(client, "runtime", return_value={"ok": False, "reason": "lock_busy"}) as runtime, \
             patch.object(client, "refresh") as refresh:
            self.assertFalse(client.send_guarded(123, send))
        send.assert_not_called()
        refresh.assert_not_called()
        self.assertEqual([c.args[0] for c in runtime.call_args_list], ["acquire"])

    def test_guard_lease_expiry_and_claim_rejection_never_send(self):
        for values in ([{"ok": False}], [{"ok": True}, {"ok": False, "reason": "duplicate_or_limit"}]):
            send = Mock(return_value=True)
            token = client._session.set({"owner": "dummy-owner", "schedule": self.settings["schedule"], "request_id": None, 'settings': self.settings, 'data': self.data})
            try:
                with patch.object(client, "enabled", return_value=True), \
                     patch.object(client, "refresh", side_effect=lambda s: s), \
                     patch.object(client, "runtime", side_effect=values):
                    self.assertFalse(client.send_guarded(123, send))
            finally:
                client._session.reset(token)
            send.assert_not_called()

    def test_ambiguous_send_failure_finishes_claim_without_retry(self):
        send = Mock(side_effect=requests.Timeout("dummy timeout"))
        token = client._session.set({"owner": "dummy-owner", "schedule": self.settings["schedule"], "request_id": "dummy-request", 'settings': self.settings, 'data': self.data})
        try:
            with patch.object(client, "enabled", return_value=True), \
                 patch.object(client, "refresh", side_effect=lambda s: s), \
                 patch.object(client, "runtime", return_value={"ok": True}) as runtime:
                with self.assertRaises(requests.Timeout):
                    client.send_guarded(123, send)
        finally:
            client._session.reset(token)
        send.assert_called_once_with()
        operations = [c.args[0] for c in runtime.call_args_list]
        self.assertEqual(operations, ["renew", "claim", "complete"])
        self.assertFalse(runtime.call_args_list[-1].kwargs["success"])
        self.assertEqual(runtime.call_args_list[-1].kwargs["request_id"], "dummy-request")

    def test_lost_completion_response_does_not_repeat_send_for_claimed_product(self):
        claimed = set()
        send = Mock(return_value=True)
        def runtime(op, **values):
            if op == "claim":
                pid = values["product_id"]
                if pid in claimed:
                    return {"ok": False, "reason": "duplicate"}
                claimed.add(pid)
            if op == "complete":
                raise RuntimeError("Scheduler network unavailable")
            return {"ok": True}
        token = client._session.set({"owner": "dummy-owner", "schedule": self.settings["schedule"], "request_id": None, 'settings': self.settings, 'data': self.data})
        try:
            with patch.object(client, "enabled", return_value=True), patch.object(client, "refresh", side_effect=lambda s: s), patch.object(client, "runtime", side_effect=runtime):
                with self.assertRaises(RuntimeError):
                    client.send_guarded(123, send)
                self.assertFalse(client.send_guarded(123, send))
        finally:
            client._session.reset(token)
        send.assert_called_once_with()

    def test_manual_request_consumed_once_even_when_schedule_is_paused(self):
        self.settings["schedule"]["paused"] = True
        consumed = set()
        operations = []
        send = Mock(return_value=True)
        def runtime(op, **values):
            operations.append(op)
            if op == "snapshot":
                return {"posts": []}
            if op == "consume":
                request = values["request_id"]
                if request in consumed:
                    return {"ok": False}
                consumed.add(request)
            return {"ok": True}
        with patch.object(client, "enabled", return_value=True), \
             patch.object(client, "runtime", side_effect=runtime), \
             patch.object(client, "refresh", side_effect=lambda s: s):
            for _ in range(2):
                with client.posting_session(self.settings, self.data, "dummy-manual-request") as allowed:
                    if allowed:
                        client.send_guarded(123, send)
        self.assertEqual(consumed, {"dummy-manual-request"})
        self.assertEqual(operations.count("consume"), 2)
        self.assertEqual(operations.count("claim"), 1)
        self.assertEqual(operations.count("release"), 2)
        send.assert_called_once_with()
        self.assertIsNone(client._session.get())

    def test_automatic_session_honors_pause_but_does_not_consume_manual_action(self):
        self.settings["schedule"]["paused"] = True
        def runtime(op, **values):
            return {"posts": []} if op == "snapshot" else {"ok": True}
        with patch.object(client, "enabled", return_value=True), \
             patch.object(client, "runtime", side_effect=runtime) as calls, \
             patch.object(client, "refresh", side_effect=lambda s: s):
            with client.posting_session(self.settings, self.data) as allowed:
                self.assertFalse(allowed)
        self.assertEqual([c.args[0] for c in calls.call_args_list], ["acquire", "snapshot", "release"])

    def test_bot_album_timeout_has_no_second_photo_send_under_scheduler(self):
        with patch.object(client, "enabled", return_value=True), \
             patch.object(client, "send_guarded", side_effect=lambda pid, send: send()), \
             patch.object(bot.config, "USE_ALBUMS", True), \
             patch.object(bot.tg, "send_album", return_value=False) as album, \
             patch.object(bot.tg, "send_photo", return_value=True) as photo:
            self.assertFalse(bot._post_images("dummy-token", 1, ["image-a", "image-b"], "caption", "link", 123))
        album.assert_called_once()
        photo.assert_not_called()

    def test_bot_backend_failure_does_not_start_posting_work(self):
        with patch.object(client, "enabled", return_value=True), \
             patch.object(client, "runtime", side_effect=RuntimeError("Scheduler network unavailable")), \
             patch.object(bot, "_run_posting") as post:
            with self.assertRaises(RuntimeError):
                bot.run_posting(self.data, self.settings)
        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
