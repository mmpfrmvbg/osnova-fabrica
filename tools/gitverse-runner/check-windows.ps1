# Проверка Windows-хоста перед регистрацией GitVerse self-hosted раннера.
# Запуск: pwsh -File tools/gitverse-runner/check-windows.ps1
# Секреты не читаются и не печатаются.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$problems = New-Object System.Collections.Generic.List[string]

function Check([bool]$ok, [string]$message) {
    if ($ok) { Write-Host "ok   $message" } else { $problems.Add($message); Write-Host "FAIL $message" }
}

$node = Get-Command node -ErrorAction SilentlyContinue
Check ($null -ne $node) 'node найден'
if ($node) {
    $version = (& node -p 'process.versions.node').Trim()
    $major = [int]($version.Split('.')[0])
    Check ($major -ge 20) "Node >= 20 (сейчас $version)"
}

Check ($null -ne (Get-Command npm -ErrorAction SilentlyContinue)) 'npm найден'
Check ($null -ne (Get-Command git -ErrorAction SilentlyContinue)) 'git найден'
Check (Test-Path (Join-Path $root '.gitverse/workflows/full-ci.yaml')) 'workflow full-ci.yaml найден'

$wsl = 'C:\Program Files\WSL\wsl.exe'
Check (Test-Path $wsl) "WSL найден: $wsl"

if (Test-Path $wsl) {
    $distros = (& $wsl -l -q 2>$null) -replace "`0", ''
    Check ($distros -contains 'e2k') 'WSL-дистрибутив e2k зарегистрирован'
    if ($distros -contains 'e2k') {
        & $wsl -d e2k -- test -x /root/qemu-build/qemu-e2k
        $qemuOk = ($LASTEXITCODE -eq 0)
        Check $qemuOk 'QEMU исполняется: /root/qemu-build/qemu-e2k'

        if ($qemuOk) {
            $qemuVersion = (& $wsl -d e2k -- /root/qemu-build/qemu-e2k --version 2>&1 | Select-Object -First 1)
            Check ($LASTEXITCODE -eq 0) "QEMU отвечает: $qemuVersion"
        }
    }
}

Check (Test-Path (Join-Path $root 'node_modules/.bin/vitest')) 'зависимости установлены (node_modules/.bin/vitest)'
if (Test-Path (Join-Path $root 'node_modules/.bin/vitest')) {
    Write-Host 'дальше вручную: npm run gate:qemu'
}

if ($problems.Count -gt 0) {
    Write-Host ''
    Write-Host "не готово: $($problems.Count) проблем(ы)"
    exit 1
}

Write-Host ''
Write-Host 'хост готов к L2; осталось зарегистрировать раннер с метками self-hosted, windows, x64'
