# GitVerse self-hosted runner для L2

L2 (`qemu-test`) требует Windows-хост: тесты вызывают
`C:\Program Files\WSL\wsl.exe` и `/root/qemu-build/qemu-e2k`. Облачный
`ubuntu-latest` этого не даёт. Пока раннера нет, job L2 стоит в очереди, а
`release` не стартует — это намеренная зависимость.

## Что должно быть на хосте

- Windows x64, Git, Node.js 20 x64 и npm.
- WSL2 с дистрибутивом `e2k`.
- Внутри `e2k`: `/root/qemu-build/qemu-e2k` (user-mode модель проекта).
- `wsl.exe -d e2k -- /root/qemu-build/qemu-e2k --version` завершается нулём.
- В корне репозитория зелёные `npm ci` и `npm run gate:qemu`.

`tools/e2k-hardware/` для L2 не нужен: это L3, живая E8C2.

## Регистрация

Официальная Windows-сборка GitVerse: `act_runner_windows_amd64` 6.1.0,
пакет `https://gitverse.ru/gitverse/-/packages/generic/act_runner_windows_amd64/6.1.0`.
Скрипт скачивает её сам (около 32 МБ), проверяет запуск и регистрирует раннер;
бинарь остаётся в `tools/gitverse-runner/.bin/` и в git не попадает.

1. GitVerse → репозиторий → CI/CD → Runners → новый локальный раннер → токен.
2. Задать токен **только через переменную окружения**, не аргументом:

```powershell
$env:GITVERSE_RUNNER_TOKEN = '<токен из интерфейса>'
pwsh -File tools/gitverse-runner/register-windows.ps1 -InstallTask
```

3. Скрипт регистрирует с метками `self-hosted:host,windows:host,x64:host`;
   имена меток совпадают с `runs-on: [self-hosted, windows, x64]` в
   [full-ci.yaml](../../.gitverse/workflows/full-ci.yaml). `-InstallTask`
   создаёт задачу автозапуска при входе пользователя и запускает её; повторный
   запуск демона не создаётся — `run-daemon.cmd` проверяет уже живой процесс.
4. Без задачи автозапуска демон можно держать вручную:

```powershell
tools\gitverse-runner\run-daemon.cmd
```

5. Проверить: Actions → `Full CI` → job `L2 QEMU` должен забрать задание, а
   не висеть в очереди.

Проверка без токена (бинарь, версия, WSL, QEMU):

```powershell
pwsh -File tools/gitverse-runner/register-windows.ps1 -CheckOnly
```

Если GitVerse не публикует Windows-сборку раннера, L2 нельзя считать
настроенным: Linux-раннер с ярлыком `windows` не заменит WSL и даст ложный
зелёный. Токен регистрации — секрет: не коммитится, не печатается, не
передаётся в аргументах командной строки.

## Проверка перед регистрацией

```powershell
pwsh -File tools/gitverse-runner/check-windows.ps1
```

Скрипт проверяет Node 20, WSL-дистрибутив `e2k`, QEMU и то, что
`npm run gate:qemu` действительно запускается. Секреты он не читает и не
печатает.
