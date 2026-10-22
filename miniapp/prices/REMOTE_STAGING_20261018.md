# PR15: измеренный remote staging и ограниченный canary

Исторический отчёт18октября. Условное разрешение получено21октября, но
canary не запущен из-за обязательного CPU gate. См.
[актуальную production проверку и оптимизацию](PRODUCTION_SAFETY_20261021.md).

Снимок: **18 октября 2026, 12:44 UTC / 15:44 МСК**.
Runtime revision: `b55dd8062c4913034eeb7243192c8d70a68c1879`.
[Draft PR15](https://github.com/22savage22/wb-deals-bot/pull/15).

**Remote staging функционально пройден. Production canary не включён.
Новых реальных WB наблюдений этого формата — 0.** Следующий шаг требует
отдельного разрешения владельца на временное развёртывание main Worker и сбор
не более 20 естественных ответов в течение максимум 24 часов. CPU остаётся
известным риском; этот результат не разрешает постоянную или массовую обработку.

## Что реально исполнялось

Существующий `nativeTick` и подготовленный collector исполнялись в настоящих
Cloudflare Workers с remote D1. Доступ — через приватный service binding и
временный локальный relay. Доступных из интернета staging endpoints, Cron,
AI binding, настоящих Telegram secrets и реальных внешних запросов нет.
WB, фотографии и Telegram подменены явно обозначенными fixtures.

20 циклов ON и 20 OFF прошли одинаковую native очередь. Тестовое старение
fixture timestamps позволяет пройти циклы без ожидания десяти часов; policy
остаётся 30 минут. Relay после испытаний остановлен.

| Проверка | Измеренный результат |
|---|---|
| 20 ON / 20 OFF | По 20 успешных simulated deliveries, ошибок 0 |
| Существующие source calls | По 20 details, 0 search, 20 photo; новых WB запросов 0 |
| Реальные WB / Telegram / AI | 0 / 0 / 0 |
| Main D1, каждые 20 циклов | Одинаково ON/OFF: 460 SQL, 1892 rows_read, 600 rows_written |
| Collector, 20 ON | 220 SQL, 1161 rows_read, 202 rows_written; максимум 11 SQL/capture |
| Цена/вариант | 20/20: доступный M SKU, 249.99 RUB; цена отсутствующего S 100 RUB исключена |
| Событие после cap20 | Complete/20; 1 SQL, 4 rows_read, 0 rows_written; simulated post работает |
| Search branch | Synthetic empty search успешен, без details и Telegram |
| Ошибка upstream | Synthetic WB403: один details, без перебора других товаров и без публикации |
| Старение при ошибке | checked_at и priceObservedAt не становятся временем новой попытки |
| Collector OFF/404 | Simulated публикация успешна, новых audit events нет |
| Финальное состояние staging | 20 ready, 0 posts/claims/deliveries; interval30; оба компонента OFF |

На основной D1 наблюдение не добавляет SQL. Консервативная сумма двух скриптов
в post fixture — 34 SQL. Это проверка данного сценария, не оценка любого
возможного вызова приложения. Полный suite ранее: **626 PASS, 0 FAIL, 1 SKIP**;
[CI runtime revision](https://github.com/22savage22/wb-deals-bot/actions/runs/39078488059)
успешен. Повторная полная локальная проверка не запускалась; готовые компоненты
не переписывались.

## CPU: ограничения вывода

GraphQL CPU quantiles возвращены в микросекундах и переведены в миллисекунды.
Фазы отделены по времени первой активации соответствующих версий.

| Реальный Cloudflare runtime | Успехи / ошибки | P50 CPU, ms | P99 CPU, ms |
|---|---:|---:|---:|
| Core ON | 20 / 0 | 19.820 | 51.305 |
| Core OFF | 20 / 0 | 21.256 | 56.089 |
| Collector ON | 20 / 0 | 3.426 | 9.556 |

ON: 12:17:39.946–12:29:36.905 UTC; OFF: 12:29:36.905–12:34:38.557 UTC.
В этой небольшой выборке наблюдение не увеличило измеренные quantiles. Это не
доказательство отрицательной стоимости или нулевой дополнительной CPU нагрузки.
Другой read-only снимок действующего production дал 23.389/91.855 ms на 10
успешных вызовах, но workload/trigger отличаются, прямое сравнение некорректно.

На Workers Free документирован номинальный лимит **10 ms CPU/invocation**, в том
числе Cron. Успех при превышении объясняется гибкостью isolate/rollover; запас
не гарантирован. Core выше 10 ms даже OFF. Отдельные P99 service bindings нельзя
складывать или вычитать как точную стоимость одной цепочки. Обычный collector
timeout/404 изолирован, но JS catch **не предотвращает платформенное прекращение
из-за CPU**. Долговременное соответствие Free CPU здесь не доказано.

Источники: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time),
[CPU metrics и rollover](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/#cpu-time-per-execution),
[GraphQL Workers metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/).

## Бесплатные лимиты аккаунта

Workers Free подтверждён владельцем в Billing → Subscriptions. Subscription API
не разрешён минимальными OAuth scopes; платёжные права не расширялись. Доступ
получен официальным device flow; новый API-токен не создавался. Секреты не входят
в отчёт, исходники, Git, логи или Obsidian.

| Общий показатель всех баз / Workers | На момент снимка | Free |
|---|---:|---:|
| D1 rows_read за UTC сутки | 266831 (5.34%) | 5000000 |
| D1 rows_written за UTC сутки | 12983 (12.98%) | 100000 |
| Все D1 | 6 / 8781824 bytes | 10 / 5 GB суммарно |
| Workers requests, отчёт analytics | 1123 | 100000/сутки |

Все reported Worker groups — success. Analytics может запаздывать и использовать
sampling; это снимок, а не обещание будущего расхода. Для visual D1 в дневной
выборке нет usage group; отсутствие группы не заменяет неизвестную величину
доказанным нулём.

| D1 | rows_read | rows_written |
|---|---:|---:|
| wb-finds-miniapp | 259868 | 8939 |
| wb-finds-style-staging | 97 | 23 |
| wb-finds-price-fixture-staging | 5521 | 3759 |
| wb-finds-price-audit-staging | 1325 | 235 |
| wb-finds-price-audit | 20 | 27 |

Перед созданием staging консервативный прогноз полных UTC суток с испытаниями:
687637 reads / 26906 writes, оставлял ≥25% общего запаса. На активации прогноз
необходимо обновить. Новые базы не дают дополнительной бесплатной квоты.

Runtime collector20 потребил 202 writes; суммарные setup/seed/schema/tests/restore
для трёх новых баз по analytics — 6866 reads / 4021 writes. **Лимит 3000 writes
относится только к runtime collector**, не ко всему staging и действующему боту.
Durable cap20, TTL≤24h, резервирование бюджета, fail-closed неизвестной metadata,
event7дней/140 и history90дней/9000 остаются в готовом коде.

Источники: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Ресурсы и изоляция

| Назначение | Новая D1 |
|---|---|
| Fixture main | wb-finds-price-fixture-staging / aacdeded-216b-4f5a-af1a-081eef724d04 |
| Fixture collector | wb-finds-price-audit-staging / f32bc65b-7867-4559-bbf2-8ac642b9c4da |
| Будущий реальный canary | wb-finds-price-audit / 653d8f5c-a0f5-43b0-9118-fbaaa4bef69f |

Future audit содержит только схему: **0 runs, 0 events, 0 history, activeRun=null**.
Private `wb-finds-price-observer` развёрнут OFF, без Cron, AI, public routes и
доступа к main D1. Он обслуживает только service-binding capture; новых WB
запросов не делает. Fixture данные не попадают в будущую реальную историю.

## Backup и откат проверены

- Main Time Travel bookmark получен API HTTP200 в 12:08 и обновлён в 12:44 UTC;
  bookmark оставлен в приватном локальном receipt. Free retention — 7 дней.
- Main active version `21b5e305-e447-4a14-82fb-230b51be6710` доступна API HTTP200.
- Настоящий staging D1 restore выполнен пять раз, чистое состояние проверено.
- Настоящий staging Worker version rollback выполнен два раза.
- Main D1 restore не вызывался, full export основной базы не скачивался.
  Это проверка наличия Time Travel и механизма на staging, а не испытание
  восстановления основной базы с её текущими данными.
- После version rollback проверять active version resources, а не только
  `/settings`: последний загруженный config может отличаться от активной версии.

В canary обычный откат — вернуть Worker version и выключить collector. Main
D1 восстанавливать автоматически нельзя: будут потеряны новые публикации,
реакции, дедупликация и профили. Отдельная audit D1 остаётся OFF для отчёта.

Источники: [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Что осталось для canary

Подготовлен OFF manifest и успешный dry-run сборки; **20/20** проверок защищённых
настроек прошли. `wrangler.jsonc` не менялся. Main получает только новый private
service binding и observation flags; audit D1 к main не привязывается. Все
существующие vars/bindings/assets/Cron сохраняются. Runtime bundle: 532211 bytes,
SHA256 `39bcc962d854e0a5eb3c28c53d5846823301c5b6bbd56808ffc4783af44b807b`.
Весь подготовленный runtime PR относительно base524fbe8: 43 файла,
3193 добавленных/41 удалённая строка (включая документы/тесты и отключённые модули).
Этот этап добавляет только отчёт и исправляет статус документации.

После отдельного разрешения выполнить по порядку:

1. Обновить account usage/прогноз с 25% резервом, main version/config hashes,
   backup bookmark, текущий прогресс публикаций и доступность rollback. При
   чужом deployment или изменённых настройках остановиться и пересмотреть diff.
2. Сверить build SHA с reviewed runtime и отдельно сверить все live bindings,
   assets и Cron с активной версией: `keep_vars` их не сохраняет. Использовать
   `keep_vars` для существующих vars; значения secrets не извлекать и не
   копировать в manifest. Не переносить fixture secrets в main. Развернуть
   reviewed main сначала OFF, без merge PR15 и без замены assets/Cron.
3. Создать новый runId со свежими start/expiry≤24h, cap20 и бюджетом collector
   ≤3000 writes/UTC сутки. Не переиспользовать staging run/start SQL. Включить
   collector и main observation с одинаковыми параметрами. Сам deployment также
   включает подготовленные исправления проверки цен; при ошибке WB старую цену
   не публикует, поэтому отдельный пост может быть отложен при неизменной policy30.
4. Читать только естественные Cron details; не выполнять manual tick/search,
   дополнительные WB запросы или повторную доставку потерянных событий.
5. Каждые пять минут проверять run/status, дневной account budget, runtime
   errors/CPU termination и heartbeat публикаций с учётом quiet window. При
   неизвестных metrics, budget stop, exceededCpu/ошибке нового runtime или
   пропущенном ожидаемом посте прекратить canary и проверить причину.
6. На 20 событиях, TTL или любой причине остановки durable guard прекращает
   запись. Оператор выключает main первым, collector вторым; без автоматического
   продления. Для временного эксперимента вернуть сохранённую main version,
   предварительно удостоверившись, что активна именно наша canary version.
   Не перезаписывать чужой более новый deployment. Проверить active versions,
   состояние канала, schedule/policy hashes и отсутствие дальнейших capture.
7. Экспортировать разрешённые поля ≤20 событий и read-only сопоставить с
   deliveries: nmId, SKU/размер, точные копейки, наличие того же SKU, timestamps,
   source/outcome/fallback и requested/effective region/payment. Раздельно
   посчитать пригодные live API quotes, ошибки/unknown, fallback и совпадения
   с публикациями. Не объявлять API quote окончательной ценой покупателя.

Защита после cap/expiry работает в коде без оператора. Пятиминутный мониторинг
и внешний rollback — отдельные операционные действия, их требуется запустить
при активации; они не заявлены уже работающими.

## Production сохранён / супернаходка WAIT

На снимке main version та же `21b5e305…`, 100%. Cloudflare Cron по-прежнему
`* * * * *`, posting policy — **30 минут**; schedule/policy hashes совпали.
Реальные deliveries продолжают появляться с интервалами около 31 минуты;
они относятся к прежнему коду и сами по себе не доказывают свежесть цен.
WB Search включён, MyStyle flags прежние, Superfind0; River SHADOW, Vision,
реакции, PR14 и настройки админки не менялись. Main Worker не загружался.

Супернаходка остаётся **WAIT**. Нет новой реальной истории сопоставимых SKU и
условий; effective region/payment пока unknown. Даже успешные 20 API quotes не
заменяют историю ≥3 дней с интервалом ≥7 дней или ≥5 достоверных сопоставимых
предложений. Ни цена basic, ни свежий timestamp ошибки скидку не подтверждают.
