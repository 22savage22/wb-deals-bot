# PR15 — проверка подготовленного патча

Дата: 2026-10-18. База сравнения этого этапа: `43fc5963` (предыдущий head PR15).
Патч не merged и не deployed. Исторический аудит реального production описан
отдельно в `PRODUCTION_SOURCE_AUDIT.md`; новые тесты не заменяют реальные данные.
Это отчёт локального этапа. Позднее remote staging, account usage и backup/
rollback проверены; актуальные результаты и риск CPU приведены в
[REMOTE_STAGING_20261018.md](REMOTE_STAGING_20261018.md).

## Автоматические проверки

- Полный JS набор: **626 PASS, 0 FAIL, 1 штатный opt-in skip** (627 tests).
  Cloudflare scheduler/admin, SHADOW, features/MyStyle, Superfind и prices.
- Сценарий с 13-часовой ценой и повторными 403 теперь запрещает публикацию;
  исходные price/stock/checked timestamps сохраняются.
- Недоступный дешёвый размер, противоречивые остатки, missing/duplicate SKU,
  копейки, HTTP/timeout fallback и безопасные подписи проверены отдельно.
- Три recent cache кандидата + 403/timeout дают только один WB вызов и ноль
  публикаций: удаление fallback не увеличивает WB нагрузку текущего post-cycle.
- OFF/TTL, отдельная D1, run isolation, дедупликация, переполнение сообщения,
  сломанный поток, отказ хранилища и отсутствие утечки ошибок проверены.
- Main deployment dry-run и отдельная сборка collector прошли. Dry-run не
  авторизуется в аккаунте и не подтверждает удалённые квоты/CPU.
- Независимые review кода и плана выпуска завершены; найденные исключение
  потока body и лишний SQL после cap устранены.

## Два изолированных Worker: 20 синтетических циклов

| Показатель | OFF | ON |
|---|---:|---:|
| Вызовы существующего WB details adapter | 20 | 20 |
| Вызовы WB search adapter | 0 | 0 |
| Проверки photo adapter | 20 | 20 |
| Simulated Telegram receipts | 20 | 20 |
| Реальные внешние запросы / Telegram / AI | 0 | 0 |
| Main SQL | 460 | 460 |
| Main rows_read | 1749 | 1749 |
| Main rows_written | 600 | 600 |

Внутренний adapter использует fixtures: ни одного WB HTTP запроса в интернете.
Сохранены 20 наблюдений/20 разных fixture ID, цена 249.99 и доступный SKU M
совпали с каждой simulated delivery; недоступная цена S=100 не выбрана.
30-минутная policy сохранена. Collector отдельно: **220 SQL / 1161 чтение /
202 записи**. Максимум main=23 SQL, collector=11 SQL; консервативная сумма
всей цепочки=34, ниже 50. Это два разных invocation; границы remote лимитов
дополнительно проверяются перед включением.

## Заполненная D1: фактическая локальная metadata

| Сценарий | Ответов × offers | rows_read | rows_written |
|---|---:|---:|---:|
| 9000 свежих history points + eviction | 20 × 20 | 8704 | 2149 |
| 9000 просроченных points + полный старый аудит | 20 × 20 | 8846 | 2219 |

Runtime включает явный start, captures и отказ после terminal; fixture seed,
проверочные чтения и миграция учитываются в отчёте отдельно. При старте очищены
20 history / 20 audit / 4 run / 2 budget-day rows, без больших DELETE scans.
Максимум capture: 11 SQL / 109 writes; start с очисткой: 12 SQL / 97 writes.
Оба укладываются в резерв 240. Суточный runtime бюджет 3000 сохраняется.

После complete, TTL, неизвестного meter и сохранённого daily-stop:
**по 1 SQL / 4 rows_read / 0 writes** на отклонение. Первый durable daily-stop
однократно требует 8 SQL / 17 reads / 4 writes. Неизвестная metadata удерживает
резерв и останавливает run. В 32 синтетических днях budget table ≤9 строк.

Даже консервативные 4 отклоняемых details callback в минуту до TTL24ч означали
бы 23040 дополнительных чтений (4×1440×4), не ноль. После complete оператор
выключает main и collector. К этой оценке добавляются действующий Worker,
остальные базы, migrations, monitoring и safety margin; остаток аккаунта этим
тестом не подтверждается. Отдельный D1 не создаёт бесплатную квоту.

## Gates на момент локального этапа (до remote staging)

- Новых реальных наблюдений/сравнений с реальными Telegram deliveries: **0**.
- Remote staging, actual account Free plan/usage/storage/DB count и CPU — gates.
- Production D1 backup/bookmark и проверка права rollback ещё не выполнены.
- Merge, deployment, включение collector и сбор production ответов запрещены
  до отдельного согласия владельца. Супернаходка остаётся WAIT.

Безопасные локальные receipts: `.test-temp/passive-staging-report.json` и
`.test-temp/passive-budget-report.json`. Они явно помечены synthetic/local;
не содержат секретов или production database contents.

Объём этапа: **29 файлов, +1575 / −54 строки** от `43fc5963`. Рабочий `wrangler.jsonc`,
MyStyle/features, PR14 bans, SHADOW/Vision и workflows в этом этапе не менялись.
Цена после будущего исправления может не пройти публикацию при ошибке WB:
неизменное расписание не должно превращать fallback в подтверждённую цену.
