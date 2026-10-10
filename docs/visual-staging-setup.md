# WB Vision: отдельный staging Worker

## Независимая ветка агента — 2026-10-10

Текущий безопасный путь: рабочая копия `D:\WB-Vision-Agent`, ветка
`codex/visual-staging-agent-20261010` от PR №7. Не менять checkout, процессы,
Builds settings, секреты или production другого агента.

Используется отдельный Worker **`wb-finds-visual-staging`**, а не version preview
production Worker. Единственная D1 — `wb-finds-visual-staging` с UUID
`5779987d-1100-45ad-8cd4-9df9c1436a20`. Native `AI` binding, fetch-only;
нет Cron, Telegram секретов, публичного приложения или WB поиска.

Локальная сборка без внешних изменений:

```text
node miniapp/cloudflare/deploy-visual-standalone.mjs
```

После отдельного официального Wrangler Device OAuth с минимальным
`workers_scripts:write` в project-local `XDG_CONFIG_HOME=.test-temp/config`:

```text
node miniapp/cloudflare/deploy-visual-standalone.mjs --deploy
```

Helper удаляет унаследованные API/runtime credentials из своего окружения,
никогда не читает global OAuth или старый AI token. Если staging Worker уже
существует, сначала проверяет его реальные bindings и отсутствие scheduled
handler. Только HTTP/provider unknown-script code 10007 допускает создание.
Любая ошибка авторизации/сети не считается отсутствующим Worker.

Новый staging sync secret генерируется только в RAM, передаётся Wrangler через
stdin и тестовому процессу через env. Это не Cloudflare API token и не секрет
production. Вывод CLI при операции с секретом скрыт. Без флага `--test` AI
вообще не вызывается; миграции и тесты ещё не являются выполненными.

Для `--deploy --test` предварительно нужна свежая подтверждённая информация из
Workers AI Dashboard о Free plan и расходе текущих UTC-суток. Оператор сохраняет
только несекретные данные в ignored `.test-temp/visual-account-budget.json`:
`source=cloudflare-dashboard`, `account_id`, `plan=free`, `day=YYYY-MM-DD`,
`observed_at` (Unix seconds), `total_neurons` (фактический расход аккаунта).
Нельзя создавать этот файл из предположений или данных прошлого дня.
Перед первым новым AI-вызовом снимок должен быть не старше 60 секунд и
оставлять минимум 5000 Neurons из бесплатных 10000. Неизвестный/недостаточный
остаток останавливает тест без AI. Уже полученные profiles и meter сохраняются
после каждого товара, чтобы следующий сетевой сбой не уничтожил доказательства.

Постоянные D1 guards: максимум 10 разных товаров/UTC day; 2500 до вызова;
фактические provider Neurons уменьшают резерв до реальной стоимости. Если
расход не возвращён, запрос прерван или остался незавершённый attempt,
`visual_budget_holds` блокирует дальнейшие AI-вызовы за этот UTC-день, включая
force и новые isolates. Кэш остаётся доступным. `/activate` не включает
автоматический анализ: исторического staging receipt недостаточно для точного
остатка бюджета всего аккаунта. River строго SHADOW.

Статус 2026-10-10: локальные tests и standalone dry-run выполнены. Cloudflare
Device OAuth истёк без подтверждённой авторизации; browser DOM/screenshot
не отвечает. **Live staging deployment, remote D1 migration и новые 10 profiles
пока не подтверждены**. Production не изменён; merge/deployment требуют нового
явного разрешения после staging QA.

## Исторический путь PR №7: shared preview (сейчас не использовать)

Следующие шаги сохранены для контекста предыдущей ветки. Независимый агент
не выполняет их и не меняет общие Workers Builds настройки.

Готовая ветка: `codex/visual-enrichment-v2`, Draft PR [№7](https://github.com/22savage22/wb-deals-bot/pull/7).
Тестовая D1: `wb-finds-visual-staging`, ID `5779987d-1100-45ad-8cd4-9df9c1436a20`.
Привязка уже подготовлена в ветке. Четыре миграции подготовлены, но в Cloudflare ещё не применены.

Здесь доступен GitHub, но нет авторизованного подключения Cloudflare. Нужен один этап настройки существующего Workers Builds в Dashboard. Новый API-токен и передача секрета не нужны.

## Кнопки в Cloudflare Dashboard

1. Откройте **Workers & Pages → wb-finds-miniapp → Settings → Domains & Routes**.
   В блоке **Version URLs** нажмите **Enable**. В старом интерфейсе блок может называться **Preview URLs**.
   Это включает доступ к URL отдельных версий; production-версию не переключает.
2. Откройте **Settings → Builds** (в документации также **Build**) → **Branch control → Edit**.
   Отметьте **Enable Preview Builds**, затем **Save**. **Production branch** оставьте `main`.
   Если интерфейс позволяет ограничить ветки preview, укажите только `codex/visual-enrichment-v2`.
   Сам скрипт прекращает работу на любой другой ветке.
3. В **Build configuration / Build settings → Edit** найдите **Preview command** и вставьте:

   ```text
   node miniapp/cloudflare/bootstrap-visual-staging.mjs
   ```

   Нажмите **Save**. Производственные Build command, Deploy command и Root directory сохраните.
4. В этих же настройках сохраните выбранный существующий **API token** Workers Builds.
   Для загрузки версии нужен **Account → Workers Scripts → Edit** этого аккаунта.
   D1 Read/Edit для этого скрипта не нужны: база уже создана, миграции идут через binding.
   Если сборка сообщает HTTP 403 или отсутствие Workers Scripts Edit, владелец может открыть
   **My Profile → API Tokens → существующий build token → Edit** и проверить указанное право
   и выбранный аккаунт. Не выбирайте старый `WB Vision AI` и не создавайте новый токен.
5. После сохранения напишите «готово». Я проверю текущую ветку, инициирую preview этой ветки
   и проведу тест через GitHub с уже существующим зашифрованным ключом синхронизации.
   Вручную запускать production deployment и изменять его DB binding не требуется.

Если этих разделов или кнопки **Edit** нет, нужен участник аккаунта, которому разрешено
изменять Workers Builds. Для настройки через существующее API-подключение требуется
**Account → Workers Builds Configuration → Edit**. Managed build credential и право
менять конфигурацию Builds — разные права.

Если вместо **Preview command** видна только новая настройка **Set up Worker Previews**,
сообщите об этом. Это переход на другой механизм preview с отдельными секретами и
binding; он требует адаптации текущего пути. Для подготовленной версии переход не нужен.

## Что выполнит тест

- Загрузит отдельную версию без перевода production-трафика. Проверит её реальный DB ID,
  native `AI` binding, ID версии и отсутствие scheduled handler.
- Инициализирует только указанную D1 четырьмя защищёнными запросами. River — SHADOW,
  Visual выключен для фоновой обработки; прямые тестовые вызовы разрешены только 10 ID.
- Проанализирует 10 реальных проверенных фотографий WB и покажет фото/профили.
  В этот тест входят футболки, поло, обувь, сумки, серьги, платья и колготки.
- Повторит обращения к профилям: кэш должен дать те же признаки без новых AI-вызовов.
- Зафиксирует фактический расход Neurons и строки D1. Лимиты: 10 товаров за UTC-сутки,
  5000 Neurons, резерв 2500 перед запросом; квота/неизвестный расход останавливают анализ.
- Сравнит 42 видимых эталонных признака: каждый возвращённый должен совпасть,
  покрытие ≥85%, цвет — у всех 10 товаров; невидимая спина и состав — unknown.
  Стиль не входит в оценку точности. Это ограниченная выборка.

Из staging нет Telegram-публикаций, Cron, поиска, изменения реакций или повторного принятия
лицензии. Production остаётся на текущей версии с автопостингом 30 минут.
Живой тест пока не выполнен. После него потребуется новое подтверждение владельца для
production-внедрения.

Официальные инструкции: [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/),
[настройки Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
[ветки Builds](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/),
[права Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/).
