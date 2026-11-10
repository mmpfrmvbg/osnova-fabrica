[CmdletBinding()]
param(
    [string]$Instance = 'https://gitverse.ru',
    [string]$Name = '',
    [string]$Labels = 'self-hosted:host,windows:host,x64:host',
    [string]$Token = $env:GITVERSE_RUNNER_TOKEN,
    [switch]$CheckOnly,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$binDir = Join-Path $here '.bin'
$exe = Join-Path $binDir 'act_runner_windows_amd64.exe'
$url = 'https://gitverse.ru/api/users/gitverse/packages/generic/act_runner_windows_amd64/versions/6.1.0/files/501609'
$minBytes = 30MB

function Get-RunnerBinary {
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    if (Test-Path $exe) {
        $have = (Get-Item $exe).Length
        if ($have -ge $minBytes) { return }
        Remove-Item $exe -Force
    }

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $curl) {
        throw 'нужен curl.exe: без него нельзя надёжно докачать 32-МБ бинарь раннера'
    }

    # Сеть GitVerse отдаёт файл порциями: докачиваем диапазонами, а не считаем
    # оборванный ответ успехом. Недокачанный exe не запускается — это проверяется ниже.
    for ($i = 0; $i -lt 20; $i++) {
        & curl.exe --fail --location --continue-at - --max-time 300 --silent --show-error --output $exe $url
        if (Test-Path $exe) {
            $size = (Get-Item $exe).Length
            Write-Host ("runner: {0:N0} из не менее {1:N0} байт" -f $size, $minBytes)
            if ($size -ge $minBytes) { return }
        }
    }
    throw "не удалось скачать act_runner целиком: $exe"
}

function Get-RunnerVersion {
    $out = Join-Path $env:TEMP ("act-runner-version-{0}.out" -f $PID)
    $err = Join-Path $env:TEMP ("act-runner-version-{0}.err" -f $PID)
    $p = Start-Process -FilePath $exe -ArgumentList '--version' -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    $text = @()
    if (Test-Path $out) { $text += (Get-Content $out -Raw) }
    if (Test-Path $err) { $text += (Get-Content $err -Raw) }
    $version = (($text -join "`n").Trim())
    if ($p.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($version)) {
        throw "скачанный act_runner не запускается (код $($p.ExitCode)): $version"
    }
    return $version
}

function Assert-Host {
    & (Join-Path $here 'check-windows.ps1')
    if ($LASTEXITCODE -ne 0) {
        throw 'хост не готов к L2: check-windows.ps1 вернул красное'
    }
}

Get-RunnerBinary
$version = Get-RunnerVersion
Write-Host "runner: $version"

if ($CheckOnly) {
    Assert-Host
    Write-Host 'готово: бинарь и хост проверены; для регистрации нужен GITVERSE_RUNNER_TOKEN'
    return
}

if ([string]::IsNullOrWhiteSpace($Token)) {
    throw 'нет токена регистрации: задайте $env:GITVERSE_RUNNER_TOKEN (в аргументы командной строки токен не передавайте)'
}

if ([string]::IsNullOrWhiteSpace($Name)) {
    $Name = ("{0}-l2" -f $env:COMPUTERNAME).Replace(' ', '-')
}

Assert-Host
Push-Location $here
try {
    if ((Test-Path '.runner') -and -not $Force) {
        throw '.runner уже есть: раннер зарегистрирован; для перерегистрации нужен -Force'
    }
    if ((Test-Path '.runner') -and $Force) {
        $backup = ".runner.bak-{0}" -f (Get-Date -Format 'yyyyMMddHHmmss')
        Move-Item '.runner' $backup
        Write-Host "старая регистрация сохранена: $backup"
    }

    $registerArgs = @(
        'register', '--no-interactive',
        '--instance', $Instance,
        '--token', $Token,
        '--name', $Name,
        '--labels', $Labels
    )
    & $exe @registerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "act_runner register завершился кодом $LASTEXITCODE"
    }
    if (-not (Test-Path '.runner')) {
        throw 'после регистрации нет .runner: раннер не сохранил настройки'
    }
    Write-Host ("зарегистрирован: name={0}, labels={1}" -f $Name, $Labels)
    Write-Host 'запуск: tools\gitverse-runner\run-daemon.cmd (или как служба/задача автозапуска)'
} finally {
    Pop-Location
}
