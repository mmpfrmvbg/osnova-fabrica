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

1. GitVerse → репозиторий → CI/CD → Runners → новый локальный раннер.
2. Скачать Windows-сборку `act_runner` со страницы раннера. Версия и ссылка
   выдаются интерфейсом; в репозиторий бинарь не кладётся.
3. Зарегистрировать с метками `self-hosted`, `windows`, `x64` (метки должны
   совпасть с `runs-on` в `.gitverse/workflows/full-ci.yaml`).
4. Запустить `act_runner daemon` и оставить его как службу/задачу автозапуска.
5. Проверить: Actions → `Full CI` → `Run workflow` → job `L2 QEMU` должен
   забрать задание, а не висеть в очереди.

Если GitVerse не публикует Windows-сборку раннера, L2 нельзя считать
настроенным: Linux-раннер с ярлыком `windows` не заменит WSL и даст ложный
зелёный.

## Проверка перед регистрацией

```powershell
pwsh -File tools/gitverse-runner/check-windows.ps1
```

Скрипт проверяет Node 20, WSL-дистрибутив `e2k`, QEMU и то, что
`npm run gate:qemu` действительно запускается. Секреты он не читает и не
печатает.
