# Notification Preferences Service

Сервис хранит настройки уведомлений пользователей и для любого модуля платформы отвечает на вопрос:
«можно ли сейчас отправить пользователю это уведомление по этому каналу?». Ответ — `allow` или `deny`
с причиной.

Стек: **TypeScript (strict), Node.js 22+/24, Fastify 5, PostgreSQL 17, zod, Luxon, Vitest, Prometheus (prom-client)**.

---

## Быстрый старт

### Всё в Docker

```bash
docker compose up --build
# сервис: http://localhost:3000, PostgreSQL: localhost:5432
```

Миграции и начальная конфигурация (дефолты и политика `marketing_sms` в `EU`) применяются при старте.
Если порты заняты: `APP_PORT=3001 POSTGRES_PORT=5433 docker compose up --build`.

### Локально (PostgreSQL в Docker)

```bash
docker compose up -d postgres   # заодно создаётся БД notification_preferences_test для тестов
npm ci
npm run dev                     # tsx watch; миграции применяются при старте (MIGRATE_ON_START=true)
```

Переменные окружения — в `.env.example` (`DATABASE_URL`, `PORT`, `LOG_LEVEL`, `MIGRATE_ON_START`).
Сборка: `npm run build && npm start`. Миграции отдельно: `npm run migrate`.

## Тесты

```bash
docker compose up -d postgres   # нужен для e2e
npm test                        # unit + e2e
npm run test:unit               # только доменная логика, без БД
npm run test:e2e                # HTTP API против реального PostgreSQL
npm run lint && npm run typecheck
```

- **Unit** (`test/unit`, 52 теста) — чистые функции домена: разбор типов/каналов, quiet hours с таймзонами
  и DST, дефолты, применение изменений, идемпотентность, порядок правил при принятии решения.
- **E2E** (`test/e2e`, 35 тестов) — через `fastify.inject` против PostgreSQL (отдельная БД
  `notification_preferences_test`, очищается перед каждым тестом). Сгруппированы по сценариям из задания:
  дефолты, изменение настроек, quiet hours, глобальные политики, идемпотентность (включая `Idempotency-Key`
  и конкурентные запросы), валидация, логи и метрики.

Если PostgreSQL на другом порту — `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/notification_preferences_test npm test`.

---

## API

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/users/:userId/preferences` | Текущие (эффективные) предпочтения |
| `POST` | `/users/:userId/preferences` | Изменить: вкл/выкл тип по каналу, quiet hours. Заголовок `Idempotency-Key` — опционально |
| `PUT` | `/users/:userId` | Явно зарегистрировать пользователя (зафиксировать текущие дефолты), идемпотентно |
| `POST` | `/evaluate` | Можно ли отправить уведомление |
| `GET` / `POST` / `DELETE` | `/policies`, `/policies/:id` | Глобальные политики |
| `GET` / `PUT` | `/default-preferences` | Дефолтные предпочтения для новых пользователей |
| `GET` | `/health/live`, `/health/ready`, `/metrics` | Эксплуатация |

### Примеры

```bash
# 1. Новый пользователь — дефолты (transactional_email включён, marketing_email выключен)
curl -s localhost:3000/users/user-1/preferences

# 2. Отключить маркетинговые email и включить маркетинговые пуши, задать quiet hours
curl -s -X POST localhost:3000/users/user-1/preferences \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: 6f1c2a' \
  -d '{
        "channels": [
          { "notificationType": "marketing_email", "enabled": false },
          { "notificationType": "marketing", "channel": "push", "enabled": true }
        ],
        "quietHours": { "start": "22:00", "end": "08:00", "timezone": "Europe/Berlin" }
      }'

# 3. Маркетинговый пуш в 23:30 по Берлину → deny / quiet_hours
curl -s -X POST localhost:3000/evaluate -H 'Content-Type: application/json' \
  -d '{"userId":"user-1","notificationType":"marketing_push","channel":"push","region":"EU","datetime":"2026-05-21T21:30:00Z"}'

# 4. Маркетинговая SMS в EU → deny / blocked_by_global_policy
curl -s -X POST localhost:3000/evaluate -H 'Content-Type: application/json' \
  -d '{"userId":"user-1","notificationType":"marketing_sms","channel":"sms","region":"EU","datetime":"2026-05-21T12:00:00Z"}'

# Новая глобальная политика: любые маркетинговые уведомления в UK запрещены
curl -s -X POST localhost:3000/policies -H 'Content-Type: application/json' \
  -d '{"notificationType":"marketing","region":"UK","description":"Marketing freeze"}'

# Чтобы снять quiet hours — "quietHours": null
```

Ответ `GET /users/:id/preferences` (сокращённо):

```json
{
  "userId": "user-1",
  "version": 1,
  "channels": {
    "transactional": { "email": { "enabled": true,  "source": "default" }, "...": "..." },
    "marketing":     { "email": { "enabled": false, "source": "user" },    "...": "..." },
    "security":      { "email": { "enabled": true,  "source": "mandatory" }, "...": "..." }
  },
  "quietHours": { "start": "22:00", "end": "08:00", "timezone": "Europe/Berlin" }
}
```

Ответ `POST /evaluate`:

```json
{
  "decision": "deny",
  "reason": "blocked_by_global_policy",
  "message": "\"marketing_sms\" is blocked in region EU by global policy: Marketing SMS are not allowed in the EU without a separate consent flow",
  "policyId": "00000000-0000-4000-8000-000000000001"
}
```

Причины (`reason`): `blocked_by_global_policy`, `disabled_by_user`, `disabled_by_default`, `quiet_hours` для
`deny`; `mandatory_notification`, `enabled_by_user`, `enabled_by_default` для `allow`.

Ошибки — единый формат `{ "error": "<code>", "message": "..." }`: `400` (невалидный ввод:
`validation_error`, `invalid_channel`, `invalid_timezone`, `channel_mismatch`, …), `404`, `409`
(`idempotency_key_conflict`), `422` (`notification_type_not_configurable`).

---

## Доменная модель и бизнес-правила

**Тип уведомления × канал.** Предпочтение задаётся для пары `(notificationType, channel)`:

- каналы: `email`, `sms`, `push`, `messenger`;
- типы: `transactional`, `marketing`, `security`;
- регионы: `EU`, `UK`, `US`, `CA`, `LATAM`, `APAC`, `MEA`, `RU`.

Всё это — закрытые union-типы (`as const` + type guards), а не произвольные строки: опечатка в регионе
политики должна давать ошибку, а не политику, которая молча никогда не срабатывает.

В условии встречаются и `marketing_email`, и пара `notificationType` + `channel`, поэтому API принимает обе формы:
`"notificationType": "marketing_email"` (канал выводится из суффикса) или `"notificationType": "marketing", "channel": "email"`.
Если указаны оба и противоречат друг другу (`marketing_sms` + `email`) — `400 channel_mismatch`.

**Свойства типов** (`NOTIFICATION_TYPE_TRAITS`):

| Тип | Пользователь может выключить | Учитывает quiet hours |
|---|---|---|
| `transactional` | да (по каналу) | нет |
| `marketing` | да | да |
| `security` | нет (всегда включён) | нет |

**Порядок принятия решения** (`src/domain/evaluation.ts`, чистая функция; срабатывает первое правило):

1. **Глобальная политика** (тип/канал/регион, `null` = «любой») → `deny / blocked_by_global_policy`.
   Политики — требования комплаенса, поэтому они сильнее всего, даже обязательных `security`.
2. **Обязательный тип** (`security`) → `allow / mandatory_notification`.
3. **Предпочтение пользователя** для пары → `deny / disabled_by_user` или `disabled_by_default`.
4. **Quiet hours** (только для типов, которые их учитывают) → `deny / quiet_hours`.
5. Иначе `allow / enabled_by_user | enabled_by_default`.

Так `reason` всегда называет самую сильную причину: если канал выключен и сейчас quiet hours — ответ
`disabled_*`, потому что уведомление нельзя отправить и после окончания тихих часов.

**Дефолты — снапшот при создании пользователя.** Дефолты лежат в таблице `default_preferences`.
Пока пользователь сервису неизвестен, он видит текущие дефолты (`version: 0`, на чтении ничего не пишется).
При регистрации (`PUT /users/:id`) или первом реальном изменении дефолты копируются пользователю
(`source: "default"`). Поэтому изменение дефолтов влияет только на новых пользователей — существующего
пользователя нельзя молча подписать на маркетинг (согласие на рассылки). Пары, которых нет в снапшоте
(например, канал добавили позже), берутся из текущих дефолтов; пары без дефолта считаются выключенными (fail closed).

**Quiet hours** — `{ start, end, timezone }`: локальное время `HH:MM` и IANA-таймзона (`Europe/Berlin`;
фиксированные смещения вроде `+03:00` не принимаются — они ломаются при переходе на летнее время).
Интервал полуоткрытый `[start, end)`, при `start > end` переходит через полночь (22:00–08:00).
`datetime` в `/evaluate` — ISO 8601 обязательно со смещением (`Z` или `+03:00`); момент переводится в
локальное время пользователя через Luxon, DST учитывается. Если `datetime` не передан — берётся текущее время.

**Идемпотентность** на двух уровнях:

1. **Декларативные команды.** Команда описывает целевое состояние («`marketing_email` = выключен»), а не
   действие («переключить»). Повторное применение не даёт изменений: `version` не растёт, в лог пишется
   `preferences_update_noop`. Явный выбор, совпадающий с дефолтом, всё равно фиксируется как `source: "user"` —
   это решение пользователя о согласии.
2. **`Idempotency-Key`** (опционально, область — пользователь). Повтор с тем же ключом возвращает
   *исходный* ответ (заголовок `Idempotent-Replayed: true`) и ничего не применяет. Это защищает от запоздалого
   ретрая: «выключить» → пользователь «включил» → ретрай «выключить» не откатывает новое изменение.
   Тот же ключ с другим телом — `409`. Тело нормализуется перед хешированием, поэтому `marketing_email` и
   `marketing` + `email` считаются одним запросом.

**Конкурентность.** Изменения одного пользователя сериализуются транзакционной advisory-блокировкой
(`pg_advisory_xact_lock` по `userId`) — она работает и для пользователя, у которого ещё нет строки в БД.
Проверка ключа идемпотентности, чтение, применение и запись — в одной транзакции. Есть тест на 10
параллельных одинаковых запросов: итоговая `version` = 1.

---

## Архитектура

Слои по принципу ports & adapters; зависимости направлены внутрь, домен не знает ни про HTTP, ни про БД.

```
src/
  domain/               чистая бизнес-логика без I/O
    notification.ts       типы, каналы, свойства типов, разбор "marketing_email"
    region.ts, user.ts    Region, UserId (branded type)
    time.ts               LocalTime, TimeZone (branded), QuietHours, DST-корректная проверка
    preferences.ts        дефолты/снапшот, применение команд, идемпотентность
    policy.ts             глобальные политики и их сопоставление
    evaluation.ts         allow/deny + причина
  application/          use cases и порты (интерфейсы репозиториев, логгера, метрик)
    preferences-service.ts  get / register / update (транзакция, Idempotency-Key)
    evaluation-service.ts   evaluate + лог решения + метрики
    admin-service.ts        политики и дефолты
    dto.ts                  контракт API
  infrastructure/       адаптеры
    db/                   пул, мигратор (advisory lock, транзакция на файл)
    persistence/          PostgreSQL-репозитории, Unit of Work
    observability/        Prometheus-метрики, логгер с привязкой к запросу
  http/                 Fastify: маршруты, zod-схемы → доменные команды, маппинг ошибок
  app.ts                composition root
  main.ts               запуск, graceful shutdown
migrations/             SQL-миграции (схема + начальная конфигурация)
test/unit, test/e2e
```

Ввод проверяется в два шага: zod проверяет *форму* запроса, доменные парсеры (`parseNotificationTarget`,
`parseRegion`, `createQuietHours`) превращают строки в доменные типы и проверяют инварианты. Дальше по коду
ходят только провалидированные типы.

**Схема БД** (`migrations/001_init.sql`):

- `default_preferences(notification_type, channel, enabled)`;
- `user_profiles(user_id, version, quiet_hours_start/end time, quiet_hours_timezone)` — с CHECK, что quiet hours заданы целиком или не заданы;
- `user_channel_preferences(user_id, notification_type, channel, enabled, source)` — `source ∈ {default, user}`; обязательные типы не хранятся, они следуют из правил домена;
- `global_policies(id, notification_type?, channel?, region?, description)` — CHECK: хотя бы одно поле scope задано;
- `idempotency_keys(user_id, idempotency_key, request_hash, response jsonb, created_at)`.

### Observability

- Структурированные JSON-логи (pino). Бизнес-события с `reqId` запроса (сквозной `X-Request-Id`):
  `preferences_updated` (diff «было → стало», версия), `preferences_update_noop`, `preferences_update_replayed`,
  `notification_evaluated` (userId, пара, регион, решение, причина, policyId, длительность),
  `user_registered`, `global_policy_created/deleted`, `default_preferences_updated`.
- `GET /metrics` (Prometheus): `notification_evaluations_total{decision,reason}`,
  `notification_evaluation_duration_seconds`, `preference_updates_total{outcome=changed|unchanged|replayed}`,
  плюс стандартные метрики процесса. Приложение зависит только от порта `Metrics`.
- `GET /health/live`, `GET /health/ready` (проверка БД).

---

## Допущения

- Пользователями управляет другой сервис; здесь `userId` — непрозрачный идентификатор. Неизвестный
  пользователь получает дефолты, а не 404, — чтобы отправители могли вызывать `/evaluate` для любого пользователя.
- Регион передаётся в `/evaluate` вызывающей стороной (как в условии) и не хранится у пользователя.
- Quiet hours одни на пользователя и действуют на все каналы для типов, которые их учитывают.
- Глобальные политики только запрещающие; несколько подходящих — побеждает самая ранняя (на решение это не влияет).
- Эндпоинты `/policies` и `/default-preferences` — административные; аутентификации в рамках задания нет.
- Начальная конфигурация (дефолты и политика `marketing_sms` в `EU`) — в миграции `002`, повторное применение безопасно.

## Что добавить для продакшена

- **AuthN/AuthZ**: пользовательские эндпоинты — только для своего `userId` (JWT), админские — по ролям; service-to-service auth для `/evaluate`.
- **Аудит изменений** — отдельная append-only таблица с историей согласий (кто/когда/откуда), это требование GDPR для маркетинга; outbox и событие `PreferencesChanged` в брокер (RabbitMQ/Kafka) для потребителей.
- **Производительность `/evaluate`** (горячий путь): кеш дефолтов и политик в памяти с инвалидацией по событию/TTL, кеш предпочтений в Redis, batch-эндпоинт для рассылок на много пользователей, read-реплики.
- **Очистка `idempotency_keys`** по TTL (cron/pg_cron, индекс по `created_at` уже есть).
- **Расширение модели**: каталог типов уведомлений в БД вместо enum в коде, quiet hours по каналам и дням недели, отложенная доставка вместо `deny` (ответ «можно после HH:MM»), разрешающие политики и приоритеты, срок действия политик.
- **API-контракт**: OpenAPI/Swagger из zod-схем, версионирование (`/v1`), optimistic locking через `If-Match: version`.
- **Эксплуатация**: OpenTelemetry-трейсинг, алерты на долю `deny` и латентность, rate limiting, миграции отдельным job'ом в CD, CI (lint, typecheck, тесты с Postgres в service-контейнере), testcontainers для e2e.
