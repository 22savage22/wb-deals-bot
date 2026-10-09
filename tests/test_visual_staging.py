"""Photo-reference gates; no API call or synthetic quality success claim."""
import unittest

from miniapp.visual_staging_check import assess_profile


class PhotoReferenceTests(unittest.TestCase):
    def setUp(self):
        self.sample = {'hash': 'a' * 64, 'expected': {'color': 'turquoise', 'sleeves': 'short'}}
        self.profile = {'images': [{'hash': 'a' * 64}], 'back_print': 'unknown', 'material': 'unknown',
                        'fields': {'color': {'value': 'blue'}, 'style': {'value': 'classic'}}}

    def test_wrong_visible_color_fails_but_unknown_is_missing_and_style_not_scored(self):
        checks = assess_profile(self.sample, self.profile)
        self.assertEqual(len(checks), 2)
        self.assertTrue(checks[0]['returned'])
        self.assertFalse(checks[0]['match'])
        self.assertFalse(checks[1]['returned'])

    def test_reference_not_reused_after_photo_bytes_changed(self):
        self.profile['images'][0]['hash'] = 'b' * 64
        with self.assertRaisesRegex(RuntimeError, 'byte version changed'):
            assess_profile(self.sample, self.profile)

    def test_invisible_back_and_material_claims_refused(self):
        for field, value in [('back_print', 'none'), ('material', 'cotton')]:
            with self.subTest(field=field):
                bad = {**self.profile, field: value}
                with self.assertRaisesRegex(RuntimeError, 'claim refused'):
                    assess_profile(self.sample, bad)
