import json
import subprocess
import unittest
from unittest.mock import patch
import admin
import state
from miniapp.learning_train import train, vector


class RiverShadowTests(unittest.TestCase):
    def batch(self):
        return {'model': {'version': 1, 'cursor': 0, 'weights': {}, 'intercept': 0,
                          'comparison': {'n': 0, 'legacy_brier': 0, 'river_brier': 0, 'posts': []}},
                'shadows': [{'pid': 1, 'ts': 100, 'legacy_p': .6, 'river_p': .5}],
                'events': [{'id': 1, 'pid': 1, 'ts': 110, 'kind': 'like', 'weight': 2,
                            'features': json.dumps({'category': 'dress', 'price': .6})}]}

    def test_real_river_learning_roundtrip_matches_edge_predictor(self):
        batch = self.batch()
        result = train(batch)
        self.assertGreater(result['weights']['category=dress'], 0)
        self.assertEqual(result['comparison']['n'], 2)
        next_batch = {**batch, 'model': json.loads(json.dumps(result)), 'events': []}
        self.assertEqual(train(next_batch)['weights'], result['weights'])
        code = "import {predict} from './miniapp/cloudflare/learning.mjs'; console.log(predict(JSON.parse(process.argv[1]),{category:'dress',price:.6}));"
        actual = float(subprocess.check_output(['node', '--input-type=module', '-e', code,
                                               json.dumps(result)], text=True))
        from river import linear_model, optim
        model = linear_model.LogisticRegression(optimizer=optim.SGD(.03), l2=.001)
        model._weights.update(result['weights'])
        model.intercept = result['intercept']
        self.assertAlmostEqual(actual, model.predict_proba_one(vector({'category': 'dress', 'price': .6}))[True])

    def test_no_invented_counterfactual_or_old_feedback_comparison(self):
        batch = self.batch()
        batch['events'][0]['ts'] = 90
        self.assertEqual(train(batch)['comparison']['n'], 0)
        batch['shadows'] = []
        self.assertEqual(train(batch)['comparison']['n'], 0)

    def test_poll_acknowledges_entire_batch_before_handling_slow_commands(self):
        data = state._empty()
        updates = [{'update_id': i, 'callback_query': {'id': str(i), 'data': 'l123'}} for i in (1, 2)]
        with patch.object(admin.tg, 'get_updates', return_value=updates), \
                patch.object(admin.tg, 'answer_callback') as ack:
            events = admin.poll('fixture', data)
            self.assertEqual(ack.call_count, 2)
            self.assertTrue(all(not event['id'] for _, event in events))
            self.assertEqual(data['tg']['offset'], 3)


if __name__ == '__main__':
    unittest.main()
