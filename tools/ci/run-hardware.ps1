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
# Ключ стенда — key.openssh в корне (в git не кладётся). Адрес и порт — docs/e2k-hardware-access.md.
param(
    [string]$HostName = 'w205p.mcst.ru',
    [string]$User = 'mmpvbg',
    [int]$Port = 8194,
    [string]$KeyPath = 'key.openssh',
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$key = Join-Path $root $KeyPath
if (-not (Test-Path $key)) {
    Write-Host "НЕТ КЛЮЧА СТЕНДА: $KeyPath отсутствует в корне — прогон не делался."
    Write-Host 'METRICS hardware=refused reason=no-key'
    exit 3
}

$wslRoot = ((& wsl -d e2k -e wslpath -a $root 2>$null) | Out-String).Trim()
if (-not $wslRoot) {
    Write-Host 'WSL-дистрибутив e2k недоступен: прогон на железе невозможен.'
    Write-Host 'METRICS hardware=refused reason=no-wsl'
    exit 3
}

function Invoke-Attempt([int]$n) {
    Write-Host "--- попытка $n : $User@$HostName`:$Port ---"
    $cmd = "cp '$wslRoot/$KeyPath' /tmp/osnova-key && chmod 600 /tmp/osnova-key && " +
           "cd '$wslRoot' && timeout $TimeoutSeconds " +
           "env E2K_HOST=$HostName E2K_USER=$User E2K_PORT=$Port " +
           "SSH_KEY_PATH=/tmp/osnova-key sh tools/e2k-hardware/ci-run.sh"
    $log = (& wsl -d e2k -e bash -lc $cmd 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $log -split "`n" | Select-Object -Last 6 | ForEach-Object { $_.TrimEnd() }

    $matched = if ($log -match 'совпало\s+(\d+)') { [int]$Matches[1] } else { -1 }
    $mismatch = if ($log -match 'расхождений\s+(\d+)') { [int]$Matches[1] } else { -1 }
    $missing = if ($log -match 'файлов нет\s+(\d+)') { [int]$Matches[1] } else { -1 }
    if ($code -eq 124) { Write-Host "попытка $n : ТАЙМАУТ ${TimeoutSeconds}с — прогон убит, это не «зелено»" }

    [pscustomobject]@{ Code = $code; Matched = $matched; Mismatch = $mismatch; Missing = $missing }
}

Write-Host "железо: $User@${HostName}:$Port (кит собран из $(Get-Location))"
$first = Invoke-Attempt 1
if ($first.Code -eq 0 -and $first.Mismatch -eq 0) {
    Write-Host "METRICS hardware: совпало=$($first.Matched) расхождений=$($first.Mismatch) нет=$($first.Missing) state=ok попыток=1 exit=0"
    exit 0
}

Write-Host 'первая попытка не прошла — вторая и последняя (третьей не будет: флаки не маскируем)'
$second = Invoke-Attempt 2
if ($second.Code -eq 0 -and $second.Mismatch -eq 0) {
    Write-Host 'ФЛАКИ: первая попытка упала, вторая прошла — это НАЗВАНО, а не спрятано'
    Write-Host "METRICS hardware: совпало=$($second.Matched) расхождений=$($second.Mismatch) нет=$($second.Missing) state=FLAKY попыток=2 exit=0"
    exit 0
}

Write-Host 'две попытки упали — это РЕАЛЬНАЯ ошибка, а не флаки'
Write-Host "METRICS hardware: попытка1(exit=$($first.Code) совпало=$($first.Matched) расхождений=$($first.Mismatch)) попытка2(exit=$($second.Code) совпало=$($second.Matched) расхождений=$($second.Mismatch)) state=REAL попыток=2 exit=1"
exit 1