import unittest
from unittest.mock import patch
import admin
import state
import tg

class FeedbackTests(unittest.TestCase):
    def cb(self, action='l', user=1, seq=1):
        return {'data': action+'123', 'from': {'id': user}, 'id': 'cb', 'update_id': seq,
                'message': {'chat': {'id': -1001}, 'message_id': 88,
                            'reply_markup': tg._buttons('https://www.wildberries.ru/catalog/123/detail.aspx', 123)}}

    def test_legacy_fallback_switches_and_repeats_without_changing_post(self):
        data = state._empty()
        with patch.object(admin.feedback_client, 'enabled', return_value=False), \
             patch.object(admin.tg, 'answer_callback'), patch.object(admin.tg, 'edit_message_reply_markup') as edit:
            for cb in (self.cb(), self.cb(user=2), self.cb('d'), self.cb('d'), self.cb('b'), self.cb('b')):
                admin._feedback('fixture', data, cb)
            self.assertEqual([data['feedback'][123][k] for k in ('likes','dislikes','bought')], [1,1,1])
            args = edit.call_args.args
            self.assertEqual(args[1:3], (-1001,88))
            self.assertEqual([b['text'] for b in args[3]['inline_keyboard'][1]], ['👍 1','👎 1','🛒 Купил 1'])
            self.assertEqual(state._norm_feedback(data['feedback'])[123]['choices']['1']['sentiment'], 'dislikes')

    def test_d1_failure_never_increments_local_counter(self):
        data = state._empty()
        with patch.object(admin.feedback_client,'enabled',return_value=True), \
             patch.object(admin.feedback_client,'save',side_effect=RuntimeError('Scheduler HTTP 503')), \
             patch.object(admin.tg,'answer_callback') as ack:
            with self.assertRaises(RuntimeError): admin._feedback('fixture',data,self.cb())
            ack.assert_called_once()
            self.assertEqual(data['feedback'],{})

    def test_worker_transport_keeps_independent_cursor(self):
        data = state._empty()
        with patch.object(admin.feedback_client,'webhook_enabled',return_value=True), \
             patch.object(admin.feedback_client,'poll_updates',return_value=[{'update_id':91,'message':{'chat':{'id':42,'type':'private'},'text':'/status'}}]), \
             patch.object(admin.tg,'get_updates') as poll:
            events=admin.poll('fixture',data)
            poll.assert_not_called()
            self.assertEqual(events[0][0],'message')
            self.assertEqual(data['tg']['worker_offset'],92)
            self.assertEqual(data['tg']['offset'],0)
            self.assertEqual(state._norm_tg(data['tg'])['worker_offset'],92)

if __name__ == '__main__': unittest.main()
