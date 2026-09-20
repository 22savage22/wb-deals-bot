"""Outfit regressions for crowded catalogs, budgets, and meaningful variants."""
import unittest
from miniapp.catalog import normalize
from miniapp.outfits import build

NOW = 1800000000


def product(pid, title, **extra):
    return normalize({'id': pid, 'title': title, 'price': 1000, 'rating': 4.9,
                      'checked_at': NOW, 'image': 'https://basket-01.wbbasket.ru/image.webp', **extra})


class OutfitChoiceTests(unittest.TestCase):
    def test_affordable_path_survives_many_higher_scoring_expensive_items(self):
        items = [product(1, 'Футболка женская', price=100)]
        items += [product(i, 'Джинсы женские', price=1800, rating=5) for i in range(10, 40)]
        items += [product(50, 'Брюки женские', price=700, rating=4.5), product(51, 'Туфли женские', price=800)]
        results = build(items, 1, 2000, now=NOW)
        self.assertTrue(results)
        self.assertEqual({p['id'] for p in results[0]['items']}, {1, 50, 51})
        self.assertEqual(results[0]['total'], 1600)

    def test_incompatible_top_ranked_items_do_not_hide_valid_shoes(self):
        items = [product(1, 'Платье летнее женское')]
        items += [product(i, 'Ботинки зимние женские', rating=5) for i in range(10, 40)]
        items += [product(50, 'Босоножки женские', rating=4.5)]
        self.assertTrue(build(items, 1, 3000, now=NOW))

    def test_budget_choice_and_third_outfit_change_clothes_not_just_accessories(self):
        items = [product(1, 'Сумка женская', price=100), product(2, 'Футболка женская'),
                 product(3, 'Футболка женская', price=500), product(4, 'Джинсы женские'),
                 product(5, 'Брюки женские', price=500), product(6, 'Кроссовки женские'),
                 product(7, 'Туфли женские', price=500), product(8, 'Серьги женские')]
        results = build(items, 1, 10000, now=NOW)
        self.assertEqual(len(results), 3)
        self.assertEqual(results[1]['label'], 'Экономнее')
        self.assertEqual(results[1]['total'], 1600)
        self.assertNotIn(8, [p['id'] for p in results[1]['items']])
        cores = [{p['id'] for p in o['items'] if p['slot'] in ('top', 'bottom', 'shoes')} for o in results]
        self.assertEqual(len({tuple(sorted(c)) for c in cores}), 3)
        self.assertTrue(all(o['total'] <= 10000 for o in results))


if __name__ == '__main__':
    unittest.main()
