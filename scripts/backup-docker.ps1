#requires -version 5.1
<#
  Backup consistente do Auto Flow Docker Desktop (Windows).
  Requer o Docker Desktop ativo e a imagem autoflow-vehicle-poster:local.
  Nunca imprime senhas/chaves e sempre tenta restaurar o estado anterior do app.
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [string]$BackupRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) { $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not $BackupRoot) { $BackupRoot = Join-Path $ProjectRoot 'backups' }
$BackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
$composePath = Join-Path $ProjectRoot 'compose.yaml'
$dataPath = Join-Path $ProjectRoot 'data'
if (-not (Test-Path -LiteralPath $composePath -PathType Leaf)) { throw "compose.yaml nao encontrado." }
if (-not (Test-Path -LiteralPath (Join-Path $dataPath 'autoflow.db') -PathType Leaf)) {
    throw "Banco autoflow.db nao encontrado. Backup cancelado."
}
if ($BackupRoot.TrimEnd('\').StartsWith($dataPath.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "A pasta de backups nao pode ficar dentro de data."
}
New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null

$compose = @('compose', '-f', $composePath, '--project-directory', $ProjectRoot)
function Invoke-DockerChecked {
    param([string[]] $ArgsForDocker)
    & docker @ArgsForDocker
    if ($LASTEXITCODE -ne 0) { throw "Falha no Docker (codigo $LASTEXITCODE)." }
}

Invoke-DockerChecked @('info', '--format', '{{.ServerVersion}}')
$containerState = & docker inspect --format '{{.State.Running}}' autoflow-vehicle-poster 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Container autoflow-vehicle-poster nao encontrado. Nao alterei outros containers."
}
$wasRunning = ($containerState -join '').Trim() -eq 'true'
$backupCompleted = $false
$backupName = $null

try {
    if ($wasRunning) {
        Write-Host "Parando apenas o Auto Flow para fazer backup consistente..."
        Invoke-DockerChecked ($compose + @('stop', 'app'))
    }

    # O servico one-off nao inicia a API. O bind ./data vem do compose.yaml.
    # O backup e gerado no host; nenhum diretorio de dados e removido.
    $mount = "$($BackupRoot):/app/backups"
    Write-Host "Criando e verificando backup do Auto Flow..."
    Invoke-DockerChecked ($compose + @(
        'run', '--rm', '--no-deps', '-v', $mount, '--entrypoint', 'node',
        'app', 'scripts/backup.mjs', 'create', '/app/backups'
    ))

    $latest = Get-ChildItem -LiteralPath $BackupRoot -Directory -Filter 'autoflow-backup-*' |
        Where-Object { $_.Name -match '^autoflow-backup-\d{4}-\d{2}-\d{2}T' } |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $latest) { throw "Backup finalizado mas a pasta de destino nao foi encontrada." }
    $backupName = $latest.Name

    Invoke-DockerChecked ($compose + @(
        'run', '--rm', '--no-deps', '-v', $mount, '--entrypoint', 'node',
        'app', 'scripts/backup.mjs', 'verify', "/app/backups/$backupName"
    ))
    $backupCompleted = $true
    Write-Host "Backup criado e verificado: $($latest.FullName)"
}
finally {
    if ($wasRunning) {
        Write-Host "Reiniciando o Auto Flow..."
        Invoke-DockerChecked ($compose + @('start', 'app'))
    }
}
if (-not $backupCompleted) { throw "O backup nao foi concluido." }
Write-Host "Concluido. Guarde uma copia da pasta de backup fora deste computador."
