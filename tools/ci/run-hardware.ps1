#Requires -Version 5.1
# Проверка на ЖИВОМ железе (Эльбрус E8C2) для конвейера.
#
# Три вещи, которых не бывает у голого «SUCCESS»:
#  1. ЧИСЛА в логе: сколько совпало, сколько разошлось, сколько файлов нет.
#  2. Изоляция прогона: ci-run.sh делает mktemp -d на каждой стороне и убирает за собой;
#     два одновременных прогона не делят /tmp, $HOME и имена файлов.
#  3. Флаки НАЗЫВАЮТСЯ, а не прячутся: две попытки, каждая логируется; «упало один раз,
#     прошло второй» = FLAKY (видно в METRICS), «упало дважды» = REAL и красное.
#
# Ключ стенда — НЕ в git (key.openssh в .gitignore). Ищем по порядку:
#   1) -KeyPath параметром;
#   2) OSNOVA_E2K_KEY — рекомендуемое имя переменной конвейера GitFlic;
#   3) E2K_SSH_KEY_PATH — то же имя понимает tools/e2k-hardware/ci-run.sh;
#   4) %USERPROFILE%\.ssh\osnova_e2k — ключ, положенный на машину агента;
#   5) key.openssh в корне — рабочая машина разработчика.
# Найденный путь и источник печатаются ДО прогона: иначе «hardware: нет ключа» не отличить от
# «взял не тот ключ», а агент клонирует репозиторий, где key.openssh нет вовсе.
param(
    [string]$HostName = 'w205p.mcst.ru',
    [string]$User = 'mmpvbg',
    [int]$Port = 8194,
    [string]$KeyPath = '',
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

# Тот же закон, что в run-qemu.ps1: вывод wsl/ssh — UTF-8, а PowerShell 5.1 по умолчанию читает его
# в CP866. Числа железа уже берутся с ASCII-строки, но «ключ/источник» и прочий текст должны быть
# читаемы, а не «Є«оз».
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$candidates = @()
if ($KeyPath) { $candidates += [pscustomobject]@{ Path = $KeyPath; Source = 'param -KeyPath' } }
if ($env:OSNOVA_E2K_KEY) { $candidates += [pscustomobject]@{ Path = $env:OSNOVA_E2K_KEY; Source = 'env OSNOVA_E2K_KEY' } }
if ($env:E2K_SSH_KEY_PATH) { $candidates += [pscustomobject]@{ Path = $env:E2K_SSH_KEY_PATH; Source = 'env E2K_SSH_KEY_PATH' } }
if ($env:USERPROFILE) {
    $candidates += [pscustomobject]@{ Path = (Join-Path $env:USERPROFILE '.ssh\osnova_e2k'); Source = '%USERPROFILE%\.ssh\osnova_e2k' }
}
$candidates += [pscustomobject]@{ Path = (Join-Path $root 'key.openssh'); Source = 'key.openssh at repo root' }

$chosen = $null
foreach ($candidate in $candidates) {
    $resolved = if ([IO.Path]::IsPathRooted($candidate.Path)) { $candidate.Path } else { Join-Path $root $candidate.Path }
    if (Test-Path -LiteralPath $resolved) {
        $chosen = [pscustomobject]@{ Path = $resolved; Source = $candidate.Source }
        break
    }
}
if ($null -eq $chosen) {
    Write-Host 'НЕТ КЛЮЧА СТЕНДА: перебраны -KeyPath, OSNOVA_E2K_KEY, E2K_SSH_KEY_PATH, %USERPROFILE%\.ssh\osnova_e2k, key.openssh.'
    Write-Host 'Положите ключ на машину агента и задайте переменную конвейера OSNOVA_E2K_KEY (или E2K_SSH_KEY_PATH).'
    Write-Host 'METRICS hardware=refused reason=no-key'
    exit 3
}
$key = $chosen.Path
Write-Host "key: $key (source: $($chosen.Source))"

$wslRoot = ((& wsl -d e2k -e wslpath -a $root 2>$null) | Out-String).Trim()
if (-not $wslRoot) {
    Write-Host 'WSL-дистрибутив e2k недоступен: прогон на железе невозможен.'
    Write-Host 'METRICS hardware=refused reason=no-wsl'
    exit 3
}

# Ключ может лежать ВНЕ рабочего каталога (например, %USERPROFILE%\.ssh) — тогда склейка
# "$wslRoot/$KeyPath" дала бы несуществующий путь. Переводим абсолютный путь через `wslpath -a`.
$wslKey = ((& wsl -d e2k -e wslpath -a $key 2>$null) | Out-String).Trim()
if (-not $wslKey) {
    Write-Host "KEY NOT VISIBLE FROM WSL: $key"
    Write-Host 'METRICS hardware=refused reason=no-key-wsl'
    exit 3
}
Write-Host "key in WSL: $wslKey"

function Invoke-Attempt([int]$n) {
    Write-Host "--- попытка $n : $User@$HostName`:$Port ---"
    $cmd = "cp '$wslKey' /tmp/osnova-key && chmod 600 /tmp/osnova-key && " +
           "cd '$wslRoot' && timeout $TimeoutSeconds " +
           "env E2K_HOST=$HostName E2K_USER=$User E2K_PORT=$Port " +
           "SSH_KEY_PATH=/tmp/osnova-key sh tools/e2k-hardware/ci-run.sh"
    # Тот же закон, что в run-qemu.ps1: stderr нативной команды — НЕ исключение. С
    # $ErrorActionPreference='Stop' любая строка прогресса ssh на stderr убила бы wrapper до METRICS.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $log = (& wsl -d e2k -e bash -lc $cmd 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    $log -split "`n" | Select-Object -Last 6 | ForEach-Object { $_.TrimEnd() }

    # ЧИСЛА ЧИТАЮТСЯ ТОЛЬКО С ASCII-СТРОКИ `OSNOVA-HW: matched=… mismatch=… missing=…`. Кириллица
    # сюда приезжает в windows-1251 (см. tools/e2k-hardware/ci-run.sh): измерено заданием #47 —
    # прогон 38/38, а regex по «совпало» дал -1, и шлюз объявил REAL.
    $matched = if ($log -match 'matched=(\d+)') { [int]$Matches[1] } else { -1 }
    $mismatch = if ($log -match 'mismatch=(\d+)') { [int]$Matches[1] } else { -1 }
    $missing = if ($log -match 'missing=(\d+)') { [int]$Matches[1] } else { -1 }
    if ($code -eq 124) { Write-Host "попытка $n : ТАЙМАУТ ${TimeoutSeconds}с — прогон убит, это не «зелено»" }

    [pscustomobject]@{ Code = $code; Matched = $matched; Mismatch = $mismatch; Missing = $missing }
}

Write-Host "hardware: $User@${HostName}:$Port (kit built from $(Get-Location))"
$first = Invoke-Attempt 1
if ($first.Code -eq 0 -and $first.Mismatch -eq 0) {
    Write-Host "METRICS hardware: matched=$($first.Matched) mismatch=$($first.Mismatch) missing=$($first.Missing) state=ok attempts=1 exit=0"
    exit 0
}

Write-Host 'первая попытка не прошла — вторая и последняя (третьей не будет: флаки не маскируем)'
$second = Invoke-Attempt 2
if ($second.Code -eq 0 -and $second.Mismatch -eq 0) {
    Write-Host 'ФЛАКИ: первая попытка упала, вторая прошла — это НАЗВАНО, а не спрятано'
    Write-Host "METRICS hardware: matched=$($second.Matched) mismatch=$($second.Mismatch) missing=$($second.Missing) state=FLAKY attempts=2 exit=0"
    exit 0
}

Write-Host 'две попытки упали — это РЕАЛЬНАЯ ошибка, а не флаки'
Write-Host "METRICS hardware: attempt1(exit=$($first.Code) matched=$($first.Matched) mismatch=$($first.Mismatch)) attempt2(exit=$($second.Code) matched=$($second.Matched) mismatch=$($second.Mismatch)) state=REAL attempts=2 exit=1"
exit 1