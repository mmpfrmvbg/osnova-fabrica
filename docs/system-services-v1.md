<!-- doc-status: frozen -->
---
# Системные сервисы ОС-НОВА v1

Системный сервис — это приложение на Основе с category: service
(или ui.kind: service, registry_kind: service),
которое живёт по тем же правилам что и обычное приложение:
манифест .osapp.yaml, permissions, invoke-API, песочница.
Отличие: сервисы работают в фоне и предоставляют API другим приложениям.

## Принципы

1. Один сервис = один манифест .osapp.yaml с category: service (или ui.kind: service)
2. Сервис регистрируется в реестре (docs/registry-v0.1.md)
3. API сервиса описывается как система.* вызовы в system-api-v1.md
4. Каждый сервис имеет golden-тест

## Текущие системные сервисы

| id | name | invoke-API | permissions | статус |
|----|------|------------|-------------|--------|
| `osnova.notifications` | Уведомления ОСи | `система.уведомления.показать` | system.notifications: true | golden ✓ |

Источник: `src/runtime/fixtures/notifications.osapp.yaml` (ui.kind: service, registry_kind: service)

## Как добавить новый системный сервис

5 шагов:
1. Создать .osapp.yaml с category: service и нужными permissions
2. Написать модуль .osnova с реализацией
3. Описать invoke-API в docs/system-api-v1.md (раздел «Стабильные» или «Experimental»)
4. Добавить запись в docs/registry-v0.1.md
5. Написать golden-тест

## Планируемые сервисы (roadmap)

| Сервис | Назначение | invoke-API (план) | Приоритет |
|--------|-----------|-------------------|-----------|
| identity | Авторизация пользователя | система.identity.* | высокий |
| clipboard | Буфер обмена | система.буфер.* | средний |
| chat | Системный чат/уведомления | система.чат.* | средний |
| scheduler | Планировщик задач | система.планировщик.* | низкий |

---
