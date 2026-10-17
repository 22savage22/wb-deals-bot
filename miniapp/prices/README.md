# Достоверные цены WB: изолированный модуль

Статус: **Draft / LOCAL STAGING / production не подключён**.
Основная база и развёрнутый Worker не изменялись. Ветка теперь содержит
исправления существующей проверки цен и выключенный passive hook.
Подробности: [план внедрения и отката](PASSIVE_ROLLOUT.md),
[результаты staging](PASSIVE_VALIDATION.md).
Продолжение аудита: [почему production публикует цены при локальном0/20](PRODUCTION_SOURCE_AUDIT.md).
Проверка production подтвердила живые WB ответы из Cloudflare. Локальный403
нельзя трактовать как отсутствие источника в Worker. Но текущий cache fallback
и потеря SKU/provenance не позволяют считать все публикации свежими retail offers.
Исследовательский `service.mjs` не содержит HTTP endpoint или Cron и не
подключается к публикациям. Новый `passive_capture.mjs` импортируется Worker
только в коде ветки; при OFF не создаёт SQL или service calls.

## Что проверено на реальных товарах

18 октября 2026, 00:28 МСК (17 октября, 21:28 UTC): **20 разных реальных
артикулов; 20/20 CDN metadata HTTP200; 0/20 подтверждённых цен и остатков**.
С локального исходящего адреса один поисковый запрос `search.wb.ru/.../v9/search` и один batch20
`card.wb.ru/cards/v4/detail` вернули **HTTP403, text/plain**. Точный механизм
или причина отказа ответом не раскрыты. Challenge-маркеры не обнаружены;
это не доказывает отсутствие защиты. Всего22 read-only запросa, без обхода.

Дополнительно одна обычная HTML-страница товара181901033 проверена без cookies
или редиректов: HTTP498, HTML1136байт, product structured data не обнаружены.
Это не источник цены. Дополнительный запрос зарезервирован в том же суточном
лимите; итог исследовательской сети23, из них исходный20товарный probe22.

Реальные артикулы теста:181901033,1477990273,198558098,1013937778,1298514533,
194118690,1248563528,913275670,399204860,1566905546,175741595,1259187328,
439121871,181519319,1477860017,883722218,26968556,355999907,338516453,147821300.
Часть названий старого каталога оказалась шире fashion-классификации;
реальная категория из CDN повторно проверяется и неподходящее отклоняется.
Рейтинг старого снимка не считается свежим. Отзывов в снимке нет, они unknown.

Отчёт и галерея создаются локально из сохранённого receipt. Их нельзя выдавать
за успешный свежий поиск. Фото/метаданные не доказывают цену, наличие, размер
или условия оплаты. Супернаходка **WAIT**, реальные скидки не заявлены.

## Переиспользование

- `shadow/discovery.mjs`: точные копейки и доступный SKU вместо минимальной
  цены отсутствующего размера.
- `shadow/value.mjs`: реальная история и сопоставимые предложения;
  зачёркнутая цена продавца не является базой скидки.
- `cloudflare/audience_quality.mjs` и `selection_policy.mjs`: действующие
  запреты владельца, включая PR14. Новые бюджетные lanes их не ослабляют.
- `features/superfind.mjs`: существующий PREVIEW_ONLY и publication proof.
- `features/catalogue_adapter.mjs`: существующий server-only ingest; новый UI
  не создаётся, browser JSON не принимается как evidence.

Разработчик должен отличать импорт функции от исполнения: `probe.mjs` использует
только чистый `cardDeal` для сравнения; scheduler/tick/post не вызываются.

## Контракт источника и доказательства

`createWBPriceSource()` делает только bounded anonymous read-only вызовы,
без cookies/Authorization, прокси, редиректов, смены региона/host при ошибке.
Детали максимум20 ID, JSON<=2MB, metadata<=128KB, timeout10s.
В ответе endpoint может быть число, но запрошенный `dest/spp` не доказывает
исполнение региона или стандартную оплату. Поэтому `priceContextConfirmed=false`,
paymentBasis unknown, число остаётся лишь `observedQuote`.

Проверенный разрешённый retail observer/feed может использовать
`normalizeApprovedObservation(input,{provider,authorizationReference,now})`.
Это **валидация контракта, не выдача разрешения на сбор**. До включения владелец
проверяет условия доступа, лицензию и право автоматической обработки.
Только серверный оператор вызывает этот код. Контракт требует:

- точный nmId и официальный WB URL; RUB, выбранный регион;
- anonymous/standard; отдельные временные отметки цены и наличия <=60мин;
- стабильный SKU, доступный вариант с той же ценой/условиями;
- настоящий priceSource `wb_page/wb_card/wb_catalog` и происхождение;
- никакой подмены seller-only цены потребительской или персональной цены общей.

Даже после подтверждения цены рекомендация дополнительно требует свежие рейтинг,
отзывы и verified category. Аналоги проходят такие же проверки; stale peers
не создают искусственный market-discount. Непроверенная аудитория остаётся unknown.

## Поиск, очередь, история

`discoverProspects()` OFF по умолчанию; explicit invocation ищет fashion по
существующим темам и фиксированным lanes100/200/300/500. `cursor` задаёт оператор
или будущий отдельно проверенный scheduler, не browser. higherPriceWatch выбирает
более дорогие товары для накопления собственной истории, не объявляет их скидкой.
Discovery только добавляет metadata в watchlist, подтверждённых цен у него0.

`refreshWatched()` OFF по умолчанию, берёт due<=20 ID одного провайдера,
резервирует лимит **до** I/O, обновляет current и историю, возвращает preview.
Preview читает историю максимум20 ID за вызов (в refresh — именно обновлённые
ID). Остальные товары могут быть проверенными аналогами, но их собственная
история в этом ответе не утверждается. Это удерживает invocation ниже50SQL.
Поставщик watch item не меняется автоматически. Ошибка никогда не возвращает
старую цену как актуальную. Missing ID тоже становится unconfirmed.

Ограничения durable storage:

| Ограничение | Значение |
|---|---:|
| Активная watchlist |100 ID|
| Batch refresh |20 ID|
| Внешние запросы |40/UTC сутки суммарно по источникам|
| Интервал источника |не менее20мин|
| Lease |120с|
| История |90дней, максимум9000точек|
| Чтение истории |<=28точек точного SKU/context|
| Очистка за ingest |<=200 старых точек|

History dedup: продукт+SKU+currency+destination+payment+UTC-day. Новые условия не
смешиваются со старыми. Для собственной скидки требуется >=3 разных дней и
интервал>=7дней; медиана собранной истории, не придуманная рыночная цена.
Для сравнения >=5 независимых доступных актуальных аналогов той же категории,
типа, комплекта и контекста. Выбросы требуют проверки, скидка>=15%.

401/403 — постоянная остановка источника, включая restart/новые сутки.
429 — durable Retry-After/backoff. Сетевые ошибки не возвращают quota reservation.
`resetSource(...,{confirmed:true})` допустим только после подтверждённого
восстановления разрешённого доступа; никаких автоматических циклов разблокировки.

## Локальный staging

Никаких прав Cloudflare или новых токенов для этих проверок не требуется.
Node24+ и зависимости существующего lockfile:

```sh
npm ci --ignore-scripts
npm run build
npm run test:prices
```

`integration.test.mjs` гоняет20 **синтетических**, явно обозначенных наблюдений
через watch→refresh→history→analysis→catalogueEnvelope→существующий
ingestVerifiedProducts с настоящими WebP fixture bytes. Проверяет сохранение
категории/аудитории/качества, старение,403 после restart и отсутствие публикаций.
Эти цены не попадают в real receipt. Отдельный Miniflare тест измеряет настоящую
локальную D1 metadata, не подставляет выдуманные row counts.

Конструктор `openPriceStore` требует явный approvedDatabaseId, отдельный
PRICE_DB и PRICE_ISOLATED:'true'. Открытие не мигрирует; `init()` только явно.
Production DB и уже используемая Vision staging DB запрещены. Для будущего
remote staging нужна **ещё одна отдельная разрешённая D1**, не они.
Удалённый staging в этой работе не развёрнут, `wrangler.jsonc` не менялся.

Пример только для локального approved DB:

```js
import {openLocalPrices} from './local_db.mjs';
import {openPriceStore} from './store.mjs';
import {pricePreview} from './service.mjs';
const local=openLocalPrices('.test-temp/my-price-staging.sqlite');
try {
  const id='explicitly-approved-local-prices';
  const store=openPriceStore({PRICE_ISOLATED:'true',PRICE_DATABASE_ID:id,
    PRICE_DB:local.DB},{approvedDatabaseId:id});
  await store.init();
  console.log(await pricePreview(store)); // no network, no publication
} finally { local.close(); }
```

`probe.mjs --live` — **одноразовая ручная диагностика**, не scheduler. Требует
локальный `.test-temp/production-catalog.json` wrapper с `.data.products`;
каталог используется только для20ID/известных фото, не price proof.
Текущий403 уже сохранён; для отчёта повторная сеть не нужна.

```sh
node miniapp/prices/report.mjs .test-temp/real-price-report.json .test-temp/gallery.html
```

## Стоимость и готовность к интеграции

Измерение18окт, локальный Miniflare/workerd, не счёт аккаунта:

| Операция |SQL|rows_read|rows_written|
|---|---:|---:|---:|
| init |15|14|21|
| track20 |2|310|60|
| due20 |1|20|0|
| acquire |7|10|6|
| ingest20 |5|364|100|
| list20 |1|20|0|
| history одного SKU |1|1|0|
| повторный ingest20 |5|305|40|
| finish403 |3|22|41|

Дополнительно проверена полная вместимость100watch/9000history: цикл
due20+acquire+ingest20+list100+history20+finish200 — **37SQL,1713reads/307writes**,
включая вытеснение20точек по cap и очистку80старых. Действующий `refreshWatched`
на таком staging:37SQL,1156reads/104writes. Preview100карточек:21SQL/660reads.
40циклов по большему замеру —68520reads/12280writes; с25%запасом85650/15350.
Это сценарий, а не гарантированный максимум billing. Незаполненные в замере
внешние auth/budget guards должны уложиться в оставшиеся13SQL Free invocation.
CPU реального Cloudflare Worker и весь аккаунт не измерены: это отдельные gates
remote staging перед допуском. Количество исходящих HTTP запросов ограничено40,
внутренние цены/вызовы существующего бота в этот лимит не входят.

Free D1:5млн rows read/сутки,100тыс written/сутки и5GBstorage, UTC reset;
записи индексов тоже учитываются. Workers Free:100тыс incomingrequests/сутки.
Это общие лимиты аккаунта: локальный benchmark не доказывает его остаток.
WorkersAI0, Telegram0, платные услуги не подключаются.
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Для подключения к админке сначала добавить owner-only preview read, используя
`pricePreview()` на отдельном binding. Для существующей Superfind передавать
только кандидатов с новым доказательством, photo hash и свежим результатом
проверки publication history; без него WAIT. `catalogueEnvelope()` готовит
только server handoff, пишет существующий ingest после собственной перепроверки.
Никаких публичных маршрутов или переключателей в этом PR нет.

Production gate: разрешённый рабочий retail source; повторный реальный20товаров
с проверкой цены/размера/региона/оплаты; сравнение на одном payload; read/write
бюджет всего заполненного модуля и запас аккаунта; независимый review; owner
подтверждает merge/deploy/D1 отдельно. До этого только draft и WAIT.

## Источники и готовые решения

Не найден и не подтверждён бесплатный универсальный разрешённый источник свежих
потребительских цен/остатков WB. Это результат проверки кандидатов, не заявление
об отсутствии любого неизвестного сервиса.

| Кандидат | Проверено | Решение |
|---|---|---|
| [WBLens](https://github.com/ordinartsev2000/WBLens) |MIT, commit ea11ee1,24авг2026; тот же undocumented cards/v4, первый размер, stock не доказан|Не устраняет403/контекст; код не копировался|
| [glmn/wb-private-api](https://github.com/glmn/wb-private-api) |root LICENSE отсутствует, package ISC; default code538355b,13мая2024|Не интегрировать по дате pushed|
| [Daytona WB SDK](https://github.com/salacoste/daytona-wildberries-typescript-sdk) |v4.7.0,ddc7f09,12окт2026; PERSONAL USE LICENSE, коммерческое применение с разрешением|Не подходит как свободная коммерческая зависимость|
| [Parser Workspace](https://github.com/alextrader2007/Wildberries-Parser-Workspace) |root license отсутствует,5dc9684,27мая2026; UC/Qrator/proxy/Gemini paths|Не запускать/не интегрировать|

Ни один чужой scraper не установлен и не запускался. Предпочтено существующее
ядро проекта и небольшой адаптер с явными доказательствами.

Официальный Seller API — подключённый магазин, не общий retail поиск. Personal
токен продавца нельзя использовать как универсальную передаваемую cloud-сессию.
403 seller API имеет документированное значение, но оно не объясняет consumer
отказ автоматически. Регион, размер, кошелёк/клуб/персональные скидки могут менять
итоговую цену. Seller-price или зачёркнутая цена не подменяют checkout evidence.

- [WB API access and integrations](https://dev.wildberries.ru/en/news/149)
- [Создание и виды токенов](https://dev.wildberries.ru/knowledge-base/articles/019d49a1-01c8-7cba-95ca-1b95904886b7/kak-sozdat-obnovit-ili-udalit-token-wb-api)
- [Коды ошибок](https://dev.wildberries.ru/knowledge-base/articles/019d49a1-2cb0-781d-8921-deaf4a014a58/rasshifrovka-kodov-oshibok-wb-api)
- [Различия покупательских скидок](https://seller.wildberries.ru/instructions/ru/ru/material/how-to-read-fimancial-reports-detalization)
- [Обновления seller stocks](https://dev.wildberries.ru/release-notes?id=272)

**Практический альтернативный путь без обхода:** ограниченная watchlist из
разрешённых выгрузок сотрудничающих продавцов либо официально одобренного retail
feed/observer. Выгрузка продавца сначала только discovery (товар/SKU/сток),
не общая цена покупателя. Для price proof требуется разрешённое наблюдение
стандартной anonymous retail цены с явно выбранным регионом/размером и временем.
Адаптер нормализует такой receipt; 1batch<=20, до40запросов/сутки, повторный
20товарный отчёт до допуска. Если provider не даёт retail evidence или право
автоматического доступа, цена остаётся unknown и публикация ждёт.

На fixture подтверждено преимущество корректности: legacy выбирает100руб у
отсутствующего S и допускаеттовар в<=200; новый normalizer выбирает доступный M
249.99 и исключает из этого lane. На настоящем blocked поиске улучшение recall,
точности или числа выгодных товаров **не доказано**. Legacy production пока не
исправлялся: это отдельный ограниченный PR без изменения работающего канала.
