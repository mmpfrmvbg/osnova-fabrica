#Requires -Version 5.1
# Шлюз QEMU для конвейера: ПИННИТ модель, гоняет оракулы и печатает ЧИСЛА.
# SUCCESS значит «тест не упал»; нам нужно «на какой модели и сколько прошло».
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$passportLine = (Select-String -Path 'src/e2k/qemuModelPassport.ts' -Pattern 'sha256' | Select-Object -First 1).Line
$expected = if ($passportLine -match '([0-9a-f]{64})') { $Matches[1] } else { '' }
if (-not $expected) {
    Write-Host 'ПАСПОРТ НЕ ПРОЧИТАН: в src/e2k/qemuModelPassport.ts не найден sha256.'
    Write-Host 'METRICS qemu=refused reason=passport-unreadable'
    exit 3
}

$actual = ((& wsl -d e2k -e bash -lc 'sha256sum /root/qemu-build/qemu-e2k 2>/dev/null | cut -d" " -f1' 2>$null) | Out-String).Trim()
if (-not $actual) {
    Write-Host 'МОДЕЛИ НЕТ: /root/qemu-build/qemu-e2k в WSL-дистрибутиве e2k не найден.'
    Write-Host 'METRICS qemu=refused reason=no-model'
    exit 3
}

Write-Host 'модель: /root/qemu-build/qemu-e2k'
Write-Host "  паспорт  sha256=$expected"
Write-Host "  на диске sha256=$actual"

if ($actual -ne $expected) {
    Write-Host 'МОДЕЛЬ НЕ ТА: числа непригодны, прогон НЕ начинался.'
    Write-Host "METRICS qemu=refused reason=model-mismatch model_sha256=$actual passport_sha256=$expected"
    exit 4
}

Write-Host 'модель совпала с паспортом — прогон начинается'
$log = (& npm run gate:qemu 2>&1 | Out-String)
$code = $LASTEXITCODE
$log -split "`n" | Select-Object -Last 8 | ForEach-Object { $_.TrimEnd() }

$files = if ($log -match 'Test Files\s+(\d+) passed') { $Matches[1] } else { '?' }
$tests = if ($log -match 'Tests\s+(\d+) passed') { $Matches[1] } else { '?' }
$failed = if ($log -match 'Tests\s+(\d+) failed') { $Matches[1] } else { '0' }

Write-Host "METRICS qemu: файлов=$files проверок=$tests провалов=$failed model_sha256=$actual passport=match exit=$code"
exit $code