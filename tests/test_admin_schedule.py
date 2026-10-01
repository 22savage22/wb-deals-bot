import copy
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import admin
import admin_schedule as controls
import scheduling


class ScheduleAdminTests(unittest.TestCase):
    def setUp(self):
        self.settings = {"max_price": 3000, "schedule": scheduling.normalize({})}
        self.data = {"meta": {}, "queue": [], "admin_ui": {}, "feedback": {}}

    def click(self, cmd):
        return controls.callback(cmd, self.data, self.settings)

    def enter(self, key, value):
        self.click("custom:" + key)
        return controls.message(value, self.data, self.settings)

    def test_view_has_status_and_five_slots_and_mobile_rows(self):
        self.data["meta"]["scheduler_status"] = {
            "queue_size": 128, "posted_today": 3, "new_today": 16,
            "heartbeat": 1790857200, "search_error": "<bad>" * 1000,
        }
        text, rows = controls.view(self.data, self.settings)
        self.assertIn("<b>128</b>", text)
        self.assertIn("5.", text)
        self.assertIn("&lt;bad&gt;", text)
        self.assertLess(len(text), 4096)
        self.assertTrue(all(len(row) <= 3 for row in rows))
        self.assertTrue(all(len(button.get("callback_data", "").encode()) <= 64 for row in rows for button in row))

    def test_all_numeric_fields_custom_and_validation_preserves_config(self):
        edits = {"post_interval_minutes": 15, "search_interval_minutes": 30,
                 "min_queue": 200, "jitter_minutes": 3, "min_post_gap_minutes": 10,
                 "max_posts_hour": 6, "max_posts_day": 100}
        for key, value in edits.items():
            result = self.enter(key, str(value))
            self.assertTrue(result[2])
            self.assertEqual(self.settings["schedule"][key], value)
        before = copy.deepcopy(self.settings)
        text, _, changed = self.enter("post_interval_minutes", "1")
        self.assertFalse(changed)
        self.assertIn("5–10080", text)
        self.assertEqual(self.settings, before)
        self.assertEqual(self.data["admin_ui"]["pending"], "schedule:post_interval_minutes")

    def test_live_worker_status_names_render_running_and_errors(self):
        self.data["meta"]["scheduler_status"] = {
            "post_running": True, "scan_running": True,
            "error": "post failed", "last_scan_error": "scan failed",
        }
        text, _ = controls.view(self.data, self.settings)
        self.assertIn("Публикация выполняется", text)
        self.assertIn("Поиск выполняется", text)
        self.assertIn("post failed", text)
        self.assertIn("scan failed", text)

    def test_presets_toggle_all_fields_and_touch(self):
        self.assertTrue(self.click("set:min_queue:300")[2])
        for key in controls.TOGGLES:
            old = self.settings["schedule"][key]
            self.assertTrue(self.click("toggle:" + key)[2])
            self.assertEqual(self.settings["schedule"][key], not old)
        self.assertIn("mtime", self.settings)
        self.assertIn("schedule_version", self.settings)
        self.assertEqual(self.settings["max_price"], 3000)

    def test_fixed_times_add_edit_delete_and_mode(self):
        self.assertFalse(self.click("mode:times")[2])
        self.click("time_add")
        self.assertTrue(controls.message("09:00", self.data, self.settings)[2])
        self.click("time_add")
        self.assertTrue(controls.message("18:30", self.data, self.settings)[2])
        self.assertTrue(self.click("mode:times")[2])
        self.assertEqual(self.settings["schedule"]["mode"], "times")
        self.click("time_edit:0")
        self.assertTrue(controls.message("10:00", self.data, self.settings)[2])
        self.assertEqual(self.settings["schedule"]["post_times"], ["10:00", "18:30"])
        self.assertTrue(self.click("time_del:1")[2])
        self.assertFalse(self.click("time_del:0")[2])
        self.assertTrue(self.click("mode:interval")[2])
        self.assertTrue(self.click("time_del:0")[2])
        self.assertEqual(self.settings["schedule"]["post_times"], [])

    def test_invalid_duplicate_and_stale_times_do_not_mutate(self):
        for value in ("24:00", "12:60", "9:30", "garbage"):
            self.click("time_add")
            before = copy.deepcopy(self.settings)
            self.assertFalse(controls.message(value, self.data, self.settings)[2])
            self.assertEqual(before, self.settings)
        self.click("time_add")
        controls.message("09:30", self.data, self.settings)
        self.click("time_add")
        before = copy.deepcopy(self.settings)
        self.assertFalse(controls.message("09:30", self.data, self.settings)[2])
        self.assertEqual(before, self.settings)
        self.click("time_edit:9")
        self.assertFalse(controls.message("10:00", self.data, self.settings)[2])
        self.assertEqual(before, self.settings)

    def test_weekdays_presets_and_last_day_guard(self):
        for preset, days in (("all", list(range(7))), ("work", list(range(5))), ("weekend", [5, 6])):
            self.assertTrue(self.click("days:" + preset)[2])
            self.assertEqual(self.settings["schedule"]["weekdays"], days)
        self.click("day:5")
        self.assertEqual(self.settings["schedule"]["weekdays"], [6])
        self.assertFalse(self.click("day:6")[2])
        self.assertEqual(self.settings["schedule"]["weekdays"], [6])
        self.assertFalse(self.click("day:7")[2])

    def test_quiet_timezone_and_jitter_validation(self):
        self.enter("quiet_start", "22:30")
        self.enter("quiet_end", "08:00")
        self.click("toggle:quiet_enabled")
        before = copy.deepcopy(self.settings)
        self.assertFalse(self.enter("quiet_end", "22:30")[2])
        self.assertEqual(before, self.settings)
        self.assertTrue(self.enter("timezone", "Asia/Yekaterinburg")[2])
        before = copy.deepcopy(self.settings)
        self.assertFalse(self.enter("timezone", "not-a-zone")[2])
        self.assertEqual(before, self.settings)
        self.enter("jitter_minutes", "10")
        before = copy.deepcopy(self.settings)
        self.assertFalse(self.click("toggle:natural_interval_enabled")[2])
        self.assertEqual(before, self.settings)

    def test_deferred_actions_unique_and_only_modify_request_metadata(self):
        original_schedule = copy.deepcopy(self.settings["schedule"])
        self.click("post_now")
        request = self.settings["schedule_post_request"]
        self.click("post_now")
        self.assertNotEqual(request, self.settings["schedule_post_request"])
        self.assertNotIn("schedule_search_request", self.settings)
        self.click("search_now")
        self.assertIn("schedule_search_request", self.settings)
        self.assertEqual(original_schedule, self.settings["schedule"])
        self.assertNotIn("post_now_ts", self.settings)
        self.assertEqual(self.data["queue"], [])

    def test_resume_clears_legacy_pause_cancel_keeps_config(self):
        self.settings["schedule"]["paused"] = True
        self.settings["pause_until"] = 9999999999
        self.assertTrue(self.click("toggle:paused")[2])
        self.assertNotIn("pause_until", self.settings)
        self.click("custom:min_queue")
        before = copy.deepcopy(self.settings)
        self.assertFalse(self.click("cancel")[2])
        self.assertNotIn("pending", self.data["admin_ui"])
        self.assertEqual(before, self.settings)

    def test_callback_ack_precedes_action_and_render(self):
        order = []
        cb = {"id": "abc", "data": "A:schedule:search_now",
              "message": {"chat": {"id": 1}, "message_id": 2}}
        real_callback = controls.callback
        def routed(*args):
            order.append("action")
            return real_callback(*args)
        with patch.object(admin.tg, "answer_callback", side_effect=lambda *args: order.append("ack")), \
             patch.object(admin, "_render", side_effect=lambda *args: order.append("render")), \
             patch.object(controls, "callback", side_effect=routed), \
             patch.object(admin.wb, "search", side_effect=AssertionError("No WB in callback")):
            self.assertTrue(admin._admin_callback("token", self.data, self.settings, cb))
        self.assertEqual(order, ["ack", "action", "render"])

    def test_schedule_command_and_pending_input_integration(self):
        with patch.object(admin.tg, "send_message") as send:
            self.assertFalse(admin._admin_message("token", 1, self.data, self.settings, "/schedule"))
            self.assertIn("Расписание", send.call_args.args[2])
            self.click("custom:min_queue")
            self.assertTrue(admin._admin_message("token", 1, self.data, self.settings, "200"))
            self.assertEqual(self.settings["schedule"]["min_queue"], 200)
            self.click("custom:min_queue")
            self.assertFalse(admin._admin_message("token", 1, self.data, self.settings, "/cancel"))
            self.assertNotIn("pending", self.data["admin_ui"])


if __name__ == "__main__":
    unittest.main()
