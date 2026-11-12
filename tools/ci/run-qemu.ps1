#Requires -Version 5.1
# Шлюз QEMU для конвейера: ПИННИТ модель, гоняет оракулы и печатает ЧИСЛА.
# SUCCESS значит «тест не упал»; нам нужно «на какой модели и сколько прошло».
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

# КОНСОЛЬ ЧИТАЕТ UTF-8, А НЕ КОДОВУЮ СТРАНИЦУ МАШИНЫ. npm/vitest пишут UTF-8, а Windows PowerShell
# 5.1 по умолчанию разбирает их вывод в CP866: кириллица в METRICS приезжала кракозябрами (задание
# qemu #56 — «файлов=63» читалось как «䠩���=63»), хотя сами числа были верны. На прямой вызов
# `npm run gate:metrics` это не влияет — там строка идёт из node в конвейер без PowerShell.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# METRICS — В ФАЙЛ, А НЕ ТОЛЬКО В ЛОГ. GitHub Actions отдаёт артефакт, который ревьюер
# открывает и читает числа, не веря строке «SUCCESS». Файл стирается в НАЧАЛЕ прогона:
# иначе упавший шаг оставил бы артефакт ПРЕДЫДУЩЕГО прогона (та же ловушка, что со старыми
# .elf в стенде). Пишется и на отказе — «чисел нет» должно быть названо, а не пропущено.
$metricsDir = Join-Path $root '.tmp'
$metricsPath = Join-Path $metricsDir 'qemu-metrics.txt'
New-Item -ItemType Directory -Force -Path $metricsDir | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($metricsPath, '', $utf8NoBom)
function Write-Metrics([string]$line) {
    [IO.File]::AppendAllText($metricsPath, $line + "`n", $utf8NoBom)
    Write-Host $line
}

# ПАСПОРТ ЧИТАЕТСЯ ПО ПОЛЮ, А НЕ ПО СЛОВУ В КОММЕНТАРИИ. Прежняя редакция брала первую строку
# со словом `sha256` — это строка комментария («sha256 бинаря: …»), 64 шестнадцатеричных знака в ней
# нет, и шлюз отказывал `passport-unreadable` ещё до прогона. Поле паспорта — `sha256: '<64 hex>'`.
$passportLine = (Select-String -Path 'src/e2k/qemuModelPassport.ts' -Pattern "^\s*sha256:\s*'[0-9a-f]{64}'" | Select-Object -First 1).Line
$expected = if ($passportLine -match '([0-9a-f]{64})') { $Matches[1] } else { '' }
if (-not $expected) {
    Write-Host 'ПАСПОРТ НЕ ПРОЧИТАН: в src/e2k/qemuModelPassport.ts не найден sha256.'
    Write-Metrics 'METRICS qemu=refused reason=passport-unreadable'
    exit 3
}

# Разбор sha256 — В POWERSHELL, а не `cut -d" "`: кавычки в аргументе, уезжающем через wsl.exe,
# разваливаются (`cut: option requires an argument: d` — измерено на этом же вызове), и шлюз
# отказывал `no-model` при живой модели. `sha256sum` печатает `<64 hex>  <путь>`.
$actualRaw = ((& wsl -d e2k -e bash -lc 'sha256sum /root/qemu-build/qemu-e2k 2>/dev/null' 2>$null) | Out-String)
$actual = if ($actualRaw -match '([0-9a-f]{64})') { $Matches[1] } else { '' }
if (-not $actual) {
    Write-Host 'МОДЕЛИ НЕТ: /root/qemu-build/qemu-e2k в WSL-дистрибутиве e2k не найден.'
    Write-Metrics 'METRICS qemu=refused reason=no-model'
    exit 3
}

Write-Host 'модель: /root/qemu-build/qemu-e2k'
Write-Host "  паспорт  sha256=$expected"
Write-Host "  на диске sha256=$actual"

if ($actual -ne $expected) {
    Write-Host 'МОДЕЛЬ НЕ ТА: числа непригодны, прогон НЕ начинался.'
    Write-Metrics "METRICS qemu=refused reason=model-mismatch model_sha256=$actual passport_sha256=$expected"
    exit 4
}

Write-Host 'модель совпала с паспортом — прогон начинается'
# НАТИВНЫЕ КОМАНДЫ ПИШУТ В stderr, И ЭТО НЕ ОШИБКА СКРИПТА. С $ErrorActionPreference='Stop'
# PowerShell 5.1 превращает ЛЮБУЮ строку stderr в исключение: измерено конвейером (задание qemu #41) —
# vitest вывел `stderr | …`, и шлюз умер ДО METRICS, хотя прогон был жив. На время нативных вызовов
# ошибки только собираются (`2>&1`), а судит пусть код возврата.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$log = (& npm run gate:qemu 2>&1 | Out-String)
$code = $LASTEXITCODE
$ErrorActionPreference = $previous
$log -split "`n" | Select-Object -Last 8 | ForEach-Object { $_.TrimEnd() }

$files = if ($log -match 'Test Files\s+(\d+) passed') { $Matches[1] } else { '?' }
$tests = if ($log -match 'Tests\s+(\d+) passed') { $Matches[1] } else { '?' }
$failed = if ($log -match 'Tests\s+(\d+) failed') { $Matches[1] } else { '0' }

# AST=ЭТАЛОН — ВТОРОЕ число того же шлюза, а не «тест прошёл»: 85 клеток эталона, сколько совпало и
# сколько прогонов модели было плохих. Скрипт спрашивает у модели напрямую (src/scripts/astMetrics.ts),
# поэтому его отказ НАЗЫВАЕТСЯ в METRICS и делает задание красным, а не пропускает проверку.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$astLog = (& npm run metrics:ast 2>&1 | Out-String)
$astCode = $LASTEXITCODE
$ErrorActionPreference = $previous
$astLog -split "`n" | Select-Object -Last 4 | ForEach-Object { $_.TrimEnd() }
$astMetric = if ($astLog -match 'AST=etalon\s+(\d+)/(\d+)') {
    "AST=etalon $($Matches[1])/$($Matches[2])"
} elseif ($astLog -match 'METRICS ast=refused reason=(\S+)') {
    "AST=etalon=refused reason=$($Matches[1])"
} else {
    'AST=etalon=?/?'
}
$qemuBad = if ($astLog -match 'QEMU=(\d+)') { $Matches[1] } else { '?' }
if ($code -eq 0 -and $astCode -ne 0) { $code = $astCode }

Write-Metrics "METRICS qemu: files=$files checks=$tests failures=$failed model_sha256=$actual passport=match $astMetric QEMU=$qemuBad exit=$code"
exit $code