# PR15: проверка production CPU и условного разрешения canary

Дата: **21 октября 2026**. Итоговый read-only снимок: **15:31 UTC / 18:31 МСК**.
Работа продолжена в той же ветке PR15, без нового проекта.

**Canary не запущен: обязательное условие безопасности Workers Free не пройдено.**
Владелец разрешил временный запуск ≤20 естественных ответов/≤24ч только после
проверки реального production CPU. При неподтверждённой безопасности велел
сначала оптимизировать. Это ограничение сохраняется и после «сделай всё сам».
Новых реальных наблюдений — **0**, достоверность 20 цен ещё не оценена.

## Реальный production, отдельно от fixtures

Cloudflare GraphQL, основной `wb-finds-miniapp`, 21 октября 13:59:25–14:59:25 UTC:

| Показатель | Фактическое значение |
|---|---:|
| Reported вызовы | 66 |
| Успех / ошибки | 66 / 0 |
| CPU P50 | **13.453 ms** |
| CPU P99 | **95.415 ms** |

Исходные CPU units подтверждены схемой GraphQL: microseconds; в таблице ms.
Это настоящий рабочий Worker, без тестовых вызовов к нему. Выборка объединяет
типы invocation; текущие GraphQL dimensions не дают eventType `scheduled/fetch`.
За последние 24ч Metrics вернули одну non-success группу: **scriptThrewException,
21 октября 01:00–02:00 UTC / 04:00–05:00 МСК**, 1 запрос/1 ошибка.
Группы `exceededCpu` в доступных результатах не обнаружено. Это не доказывает
отсутствие HTTP1102 во всех несэмплированных логах.

Номинальный Free лимит — **10 ms/invocation, включая Cron**. Успешный rollover
при превышении не гарантирует устойчивый запас. P50 уже выше этого лимита;
требуемый безопасный CPU не подтверждён. Исходный Worker не заменялся.

Источники: [CPU limits / exceededCpu / 1102](https://developers.cloudflare.com/workers/platform/limits/#cpu-time),
[CPU sampling и rollover](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/#cpu-time-per-execution).

## Подробные Logs и live profiling

- Официальный Telemetry query API для агрегатов уже существующих CPU logs
  вернул **HTTP403 / Cloudflare10000** с текущим OAuth. Новое логирование не
  включалось. Для API требуется Workers Observability Write; имеющихся
  account:read/workers_scripts:write/d1:write для этого запроса недостаточно.
- Поддерживаемый текущим Wrangler список login scopes не содержит отдельного
  Workers Observability scope. Новые API tokens не создавались; auth guards
  не модифицировались. Секреты остаются в keyring/памяти процесса.
- После просьбы выполнить всё самостоятельно Computer Use однократно проверил
  доступные окна: targetable Opera/Cloudflare не обнаружены. Повторных UI
  попыток/тайм-аутов не было. Другие приложения/сессии не автоматизировались.
- Официальный production CPU profiler для активной версии ответил HTTP200.
  Один capture1000ms показал idle; второй ограниченный capture50000ms дал только
  четыре sample с root/GC/idle, без прикладных функций. Профиль не вызывал Worker
  и не создавал WB/Telegram запросы. Сам по себе он не объясняет расход конкретного
  Cron. Raw profiles/логи не сохранялись, агрегированные безопасные результаты
  оставлены локально. Повторять capture без полезного сигнала не стали.
- GraphQL CPU периодически отвечал `budget`: rate limiter просит ждать5мин.
  Удачные результаты отделены от неудачных попыток; ошибка метрик не считается
  нулевым CPU. Непрерывная доступность такого мониторинга пока не подтверждена.

Причина единственного ночного исключения **не установлена**. Не называем его
CPU ошибкой по одному времени/статусу и не выдаём отсутствие Logs доступа за
успешную диагностику. Для следующего этапа нужен доступ к подробным событиям
или полезный профиль естественного Cron; тариф/права/секреты не расширялись.

Источники: [Telemetry query permission/schema](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/),
[production profiling](https://developers.cloudflare.com/workers/observability/profiling-in-production/).

## Выполненная оптимизация в PR15

Три изменения runtime:

Объём кода этого этапа: **3 runtime файла, +32/−13 строк; 2 тестовых файла,
+35 строк**. Готовые компоненты не переписывались.

1. Внутренний D1 ledger не хеширует SQL повторно. Счётчики, coverage, неизвестная
   metadata, обработка ошибок и атомарные резервы сохранены. Внешний meter
   по-прежнему формирует top queries для диагностики.
2. Расчёт posting window переиспользуется только для одного проверенного
   snapshot и того же времени. После нового чтения расписания окно считается
   заново; проверки после WB и непосредственно перед Telegram не перенесены.
   Публичные postingWindow/postDue сохраняют validation.
3. Heartbeat UPDATE и следующий header SELECT объединены в один
   `UPDATE … RETURNING` с прежними ограниченными scalar subqueries. Возвращается
   одна строка; D1 metadata не теряется. Запись остаётся до try, decode/validation
   внутри. SQL ошибка scalar subquery теперь идёт во внешний обработчик;
   повреждённое состояние останавливается без публикации.

**63 различных целевых теста PASS**: scheduler, цены, D1 budget/guard,
read optimization. Включены новые проверки nested meter/unknown metadata/
ошибки D1 и паузы владельца во время WB details. При такой паузе Telegram send
не выполняется. Полный локальный suite заново не запускался. Независимый
read-only review не нашёл блокирующих ошибок. Проверка всего PR — штатный CI.

## Remote staging A/B оптимизации

Тот же private fixture Worker и та же отдельная D1; никаких production bindings,
настоящего Telegram, Cron, AI или public routes. Harness включает оба D1 meter
и настоящий withReadBudget, как scheduled composition. В каждой фазе:
**8 synthetic post + 8 idle**, оба раза чистое одинаковое начальное состояние.
Истёкшие за3дня даты fixtures обновлены только в тестовой очереди.

| Официальная remote D1 metadata | До | После |
|---|---:|---:|
| SQL / 16 циклов | 263 | **247** |
| Rows read / written | 1024 / 298 | **1024 / 298** |
| SQL / post | 25 | **24** |
| SQL / обычный idle | 7 | **6** |
| SQL / idle с maintenance | 14 | **13** |
| Simulated deliveries | 8 | 8 |
| Настройка interval | 30 минут | 30 минут |
| Реальные WB / Telegram / AI | 0 / 0 / 0 | 0 / 0 / 0 |

SKU/цена/наличие fixtures и сетевые adapter counts совпали. Collector всё время
OFF. `UPDATE … RETURNING` принят настоящей D1, metadata доступна.
После сравнения fixture D1 возвращена в20ready/0posts/claims/deliveries,
interval30; staging OFF/private, без Cron/AI/public URL. Локальный relay остановлен.

Успешный CPU снимок15:15:44UTC сообщил **по15 вызовов из16 receipts** каждой
фазы: до P50/P99 **7.756/16.156 ms**, после **6.248/28.119 ms**. Границы/
sampling ограничивают полноту; попытка уточнить полную выборку получила budget.
Эти числа не выдаются за полную16/16 статистику. Наблюдаемая медиана снизилась,
P99 вырос; малая выборка **не доказывает** улучшение хвоста или устойчивый Free
CPU. Даже данный candidate P99 выше10ms. Дальнейшие canary проверки не запускались.

## Production, квоты и откат

На15:31UTC:

- Main active version прежняя: `21b5e305-e447-4a14-82fb-230b51be6710`,100%.
  Rollback version доступна API HTTP200. Schedule/policy SHA256 совпали с
  начальным снимком, Cron прежний `* * * * *`, policy interval30.
- D1 всех баз: **325132/5000000 reads (6.50%)**, **11360/100000 writes (11.36%)**;
  6 баз, около9.55MB. Это текущий дневной snapshot с lag analytics, не прогноз
  будущего расхода. Runtime canary не потратил записей: он не запускался.
- Основная база Time Travel bookmark обновлена API HTTP200, хранится приватно.
  Main restore/export не выполнялись. Staging restore/rollback были проверены
  ранее; для обычного будущего отката main D1 не восстанавливать.
- За время read-only проверки появился штатный delivery379444432 в18:01:48МСК;
  интервал от предыдущего около31мин. Heartbeat свежий, watchdog_overdue=false,
  search успешен, reactions_initialized=1. Эти записи прежнего кода не являются
  новыми подтверждёнными ценами. Отдельный искусственный тест Telegram/реакций
  не проводился. Пропуски из-за canary не оцениваются: canary отсутствовал.
- Future audit: **0 runs/events/history, activeRun=null**. Private production
  collector остался capture0/passivefalse; main observer binding отсутствует.
- Платных услуг, billing изменений, новых токенов, WB запросов и Telegram
  действий от аудитора —0. Workers Free ранее подтверждён владельцем18октября;
  нового подтверждения тарифа через недоступный subscription API не выдумываем.

MyStyle, PR14, реакции, River SHADOW, Vision и настройки админки не изменялись.

## Состояние подготовленной сборки / следующий шаг

Main OFF dry-run успешен, upload/deploy не выполнялись. Новая сборка533025bytes,
SHA256 `c03dd19e73997c1b194fbf446c64aa278f6f3135c5edcac92adf11632c95485e`.
Bundle18октября после оптимизации устарел и не должен использоваться для запуска.
Основной `wrangler.jsonc` не менялся. Операционные receipts находятся локально в
`.test-temp/production-safety-20261021`; публичные копии не содержат bookmark,
credentials, raw logs/профилей или персональных данных.

Условное разрешение владельца получено; повторно спрашивать его для того же
согласованного scope не нужно. Но разрешение **не снимает CPU gate**. Дальше:
полезный разбор естественных scheduled/fetch events и причины ночного исключения,
дальнейшая измеренная оптимизация, подтверждение CPU и доступного мониторинга.
Затем обновить quota/backup/version/config и только при выполнении всех условий
запускать ≤20 естественных ответов/≤24ч с остановкой и безопасным version rollback.
Фонового автоматического старта нет. Новые массовые прогоны не включены.

Супернаходка остаётся **WAIT**: нет собранной реальной сопоставимой истории и
подтверждения effective региона/оплаты. API quote не становится final buyer price.
