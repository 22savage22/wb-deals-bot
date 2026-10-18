# PR15: исправления цен и пассивное наблюдение

Статус 2026-10-18: код подготовлен в существующей ветке PR15. **Production
не развёрнут, наблюдение выключено, реальных наблюдений нового формата — 0.**
Изолированные local и remote staging используют синтетические WB/Telegram
ответы. Remote staging выполнен в настоящих Cloudflare Workers; измерения и
ограничение CPU: [REMOTE_STAGING_20261018.md](REMOTE_STAGING_20261018.md).

## Исправления в существующем пути публикации

- Ошибка WB, timeout и 403 больше не разрешают публикацию сохранённой цены.
  `priceObservedAt`, `stockObservedAt` и `checked_at` при неудаче не обновляются.
  Время попытки/ошибки и `fallback:true, priceStatus:unconfirmed` записываются отдельно.
  После сетевой/HTTP ошибки текущий post-cycle прекращается: очередь не вызывает
  дополнительные WB проверки других кандидатов вместо удалённой fallback-публикации.
- Цена и положительный остаток принадлежат одному стабильному SKU. Неизвестный,
  дублирующийся SKU и противоречивые остатки не проходят проверку.
- Копейки сохраняются: 24999 копеек → 249.99 рубля. Минимальная цена
  отсутствующего размера не подменяет цену доступного размера.
- Успешный details имеет время завершения получения JSON WB, источник, метод,
  статус, SKU/размер и отдельные признаки API observation / retail confirmation.
- Подпись сообщает «Цена из ответа WB», выбранный размер/SKU и зависимость
  окончательной цены от размера, региона и оплаты. Обещание проверки любой
  fallback-цены убрано. Зачёркнутая basic-цена не объявляется реальной скидкой.

30-минутная настройка и Cron не меняются. После применения исправления при
недоступности WB публикация может быть отложена: расписание не гарантирует
публикацию неподтверждённой цены. До deployment поведение production прежнее.

## Поток без дополнительных WB-запросов

`existing native details → bounded public-field copy → waitUntil service binding
→ private collector Worker → отдельная D1`.

Ни collector, ни sanitizer не вызывают Wildberries. Search не копируется.
Наблюдение применяется к естественным details из Cron; ручная проверка и
ручной tick по умолчанию не включают hook. Повторной загрузки при потере
события нет. Ошибка/timeout collector не прерывает публикацию.

Сохраняются nmId, стабильный SKU и размер, десятичная цена/RUB, наличие именно
этого SKU, price/stock timestamps, время события, `wb_card/GET/native_details`,
HTTP status, outcome, `fallback:false`, verification status. Для сетевой ошибки
status=0 и время ошибки не становятся временем наблюдения цены/остатка.
Для 403/ошибки цена и наличие остаются unknown; сохранённая старая цена не
копируется в событие как новый факт.

`requestedContext` содержит только фактически отправленные curr/dest/spp;
`effectiveContext=null`, payment unknown и `retailConfirmed:false`, пока нет
независимого подтверждения условий. Запрошенный регион не считается доказанным
регионом расчёта. API-котировка не утверждается окончательной ценой покупателя.

Сохраняются только разрешённые поля. Нет исходного тела/URL с произвольными
параметрами/заголовков/tokens/cookies/user IDs. Встроенные 20 cards, 100 sizes,
100 stock rows и 64 KiB ограничивают работу копирования и передачу.

## Защита D1 и жизненный цикл

| Ограничение | Значение |
|---|---:|
| Один явный запуск | максимум 20 исходных ответов, не 20 гарантированно разных товаров |
| Карточек в ответе | максимум 20 |
| TTL запуска | максимум 24 часа, без автоматического продления/перезапуска |
| Дополнительные записи collector | резервирование и учёт ≤3000 rows_written/UTC сутки |
| Event audit | 7 дней, максимум 140 событий |
| Quote history | 90 дней, максимум 9000 точек |
| История точного ключа за чтение | максимум 28 точек |
| Очистка за capture | максимум 10 устаревших history points |

История делится по nmId + SKU + requested/effective context + UTC day.
Первая точка за день не выдаётся за более позднюю перепроверку. Новые события
хранят свои собственные timestamps. Количественные caps действуют в SQL с
индексами и триггерами; при бездействии физическая очистка откладывается до
следующего явно разрешённого запуска/capture. Просроченные записи не выдаются
через API; это логический TTL с ограниченной последующей физической очисткой.

Capture заранее резервирует worst-case расход, затем сверяет фактические
`meta.rows_written`, включая индексы/триггеры. Неизвестная metadata останавливает
запуск и удерживает резерв. Ошибка не разрешает повторный сбор WB. Если дневной
запас недостаточен, сбор останавливается раньше 20; ради красивого результата
лимит не повышается. Для stop оставлен отдельный запас.

После complete/expiry/duplicate/wrong-run ранний durable guard делает не более
одного SQL чтения без записей. Новый Cron isolate может доставить такое
отклоняемое событие до TTL: это не означает нулевой расход чтений после cap.
При завершении оператор выключает обе стороны. При выключенных flags нет
обращений к service binding и D1 collector.

**3000 — бюджет только collector.** Основная база, «Мой стиль», реакции и
прочие D1 делят общую квоту аккаунта. Отдельная база не добавляет бесплатную
квоту. Официальные Free лимиты: 5 млн прочитанных / 100 тыс. записанных строк
в UTC сутки, 5 GB/account, 500 MB/database, максимум 10 баз и 50 SQL/invocation.
До включения суммарный фактический расход должен оставлять минимум 25% общего
запаса после консервативного прогноза действующего Worker и collector.
Локальный D1 meter не является аккаунтной статистикой или гарантией CPU.

Источники: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).

## Воспроизводимый staging

`npm run prices:passive:staging` поднимает два логических main Worker (ON/OFF)
с разными D1 и отдельный private collector. Внешний доступ запрещён на границе
workerd. Используется настоящий `nativeTick`, но все WB/photo/TG ответы —
fixtures. 20 simulated deliveries сравниваются с 20 сохранёнными наблюдениями.
Тестовый сдвиг возраста fixture posts/claims позволяет пройти 20 циклов без
смены 30-минутной policy и без ожидания 10 часов. Это не 20 реальных цен.

Отчёт: `.test-temp/passive-staging-report.json`. Отдельный budget probe проверяет
заполненную историю и измеряет реальные локальные D1 метаданные. Точные итоги
последнего запуска приведены в `PASSIVE_VALIDATION.md`.

Remote staging **выполнен 18 октября 2026** через официальный Wrangler device
flow с подтверждением владельца. Нового API-токена нет; OAuth credentials
защищены локальным keyring. Владелец подтвердил Workers Free в Dashboard.
20 ON и 20 OFF replay прошли в private Workers с отдельными D1. Проверены cap,
ошибки WB/collector, search branch и настоящий staging rollback/Time Travel.
Фактический account D1 запас достаточен, но стабильный запас CPU на Free
**не доказан**: core P50 выше номинальных 10 ms как ON, так и OFF. Поэтому
допустим только отдельно разрешённый ограниченный canary с мониторингом.
Будущий production collector уже развёрнут **OFF**, его отдельная D1 пуста.
Main Worker не загружался и не развёртывался; canary ещё не разрешён.

## Процедура remote staging и production

Шаги 1–5 выполнены; подробные receipts и план оставшихся шагов — в
[измеренном отчёте](REMOTE_STAGING_20261018.md). Далее требуется отдельное
разрешение владельца на шаг 7 с учётом риска CPU. При активации заново проверить
квоты, main version/config и получить свежий backup bookmark.

1. В Cloudflare выбрать аккаунт проекта. Workers & Pages → D1 SQL Database:
   проверить количество баз, размер и Metrics всех баз за текущие UTC сутки;
   Workers & Pages → Overview/Usage и Billing → Subscriptions: подтвердить Free.
   Снимки без секретов допустимы; API token в чат не нужен. Для автоматической
   проверки нужен существующий доверенный доступ Workers Scripts Edit и D1
   Edit выбранного аккаунта, а для read-only метрик Account Analytics Read.
   Наличие Dashboard-сессии само по себе не даёт эти права текущему процессу.
2. Выделить три независимых D1: fixture core staging, fixture audit staging,
   чистую будущую `wb-finds-price-audit`. Main/Visual/MyStyle D1 запрещены.
   Нельзя собирать fixtures в будущую production-history. При нехватке места
   в бесплатном лимите 10 баз — остановиться, платный план не подключать.
3. `prices:passive:prepare` принимает три реальные разрешённые UUID, runId,
   start/expiry epoch-ms. Оно только создаёт файлы в `.test-temp/passive-release`:
   два private collector manifests/entrypoints с pinned DB ID, private fixture
   staging manifest, миграцию, review-only start SQL, OFF production fragment.
   Основной `wrangler.jsonc` не редактируется, существующие vars не заменяются.
   Production collector и staging collector имеют разные имена и базы.
4. На **staging** D1 сначала проверить identity/schema (`sqlite_master` не
   содержит чужого production schema), применить миграцию только audit DB,
   загрузить ту же синтетическую native bootstrap fixture в core staging DB.
   Это отдельный trusted operator шаг, не публичный HTTP init. Оба Worker
   private, без workers.dev/preview URL, внешних routes, Cron, AI или настоящих
   Telegram secrets. Через доверенный service-binding harness повторить ON/OFF
   replay и failure cases. Проверить CPU и SQL в Cloudflare, не по wall time PC.
5. Зафиксировать текущие main SHA, Worker version/config/flags, расписание и
   [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
   bookmark основной D1 (Free: 7 дней); при необходимости private export + SHA.
   На 18 октября bookmark main D1 получен, active version доступна, восстановление
   из Time Travel и version rollback проверены только на staging. Это не
   full export и не испытание восстановления основной базы. Не выгружать её содержимое в PR,
   отчёты, Obsidian или публичные CI artifacts. Проверить доступ к rollback.
6. Показать итог staging, account budgets, backup и точный diff владельцу.
   Получить **отдельное разрешение на production deployment и 20 наблюдений**.
   Текущее разрешение на разработку этого не заменяет. До него все flags OFF.
7. После разрешения: применить миграцию только чистой audit DB; deployed private
   collector сначала OFF; применить рассмотренный патч main с OFF fragment,
   сохранив bindings, vars, Cron и assets. Проверить исходные настройки. Явно
   выполнить start SQL только с новым согласованным runId/TTL; включить collector
   PRICE_CAPTURE_ENABLED=1 / PRICE_PASSIVE_ENABLED=true, затем main observation=1.
   Не запускать manual tick/search ради наполнения. Ждать только обычные Cron.
8. Stop: main observation=0 первым; collector capture=0 вторым. Complete после
   20, expiry или budget отказ не запускают новый run. Сохранить безопасный export
   максимум 20 событий и прочитать соответствующие deliveries без изменения main.

Приватный collector имеет только POST `/capture` через service binding. Нет
публичного start/stop/export endpoint. Операционные SQL/exports выполняются
только оператором через авторизованный D1 доступ. Generated start SQL относится
к новой изолированной базе и держит полный стартовый резерв; для последующих
запусков с историей используется reviewed `store.start()` с bounded cleanup.

## Откат и проверка реальных наблюдений

Первый откат — выключить main observation и collector. Если нужен откат
ценового runtime, вернуть сохранённую Worker version/config. Не откатывать main
D1 автоматически: это удалило бы новые посты, дедупликацию, реакции и профили.
Изолированная история не участвует в текущих публикациях и может оставаться OFF.

После разрешённого сбора сопоставить nmId+SKU+точную цену+timestamps с
`scheduler_deliveries` и записанной Telegram receipt. По времени доставки без
этих фактов цену подтверждённой не считать. Раздельно посчитать live API,
ошибки/unknown, fallback, изменения цены/размера, неполные условия и фактические
публикации. Ничего не подтверждать задним числом из старого `checked_at`.

## Супернаходка остаётся WAIT

`observed_quote_history` специально не передаётся в retail ingestion/скоринг.
Нужны свежая доступность того же SKU, подтверждённый регион/оплата и история
сопоставимых условий. Существующие gates: ≥3 разных дней с интервалом ≥7 дней
для собственной истории, ≥5 независимых свежих сопоставимых аналогов для
рыночного сравнения; качество/категория проверяются отдельно. API `basic` и
неизвестные условия не создают скидку. После доказательства этих условий можно
отдельным reviewed patch подключить историю к существующему value engine.

PR14 bans, My Style, реакции, River SHADOW, Vision и текущая админка не меняются.
