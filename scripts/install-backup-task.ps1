#requires -version 5.1
<#
  Cria a tarefa de backup diario para o usuario logado no Windows.
  Docker Desktop precisa ser iniciado apos o login; nao funciona com PC desligado.
#>
[CmdletBinding()]
param([string]$At = '03:00')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($At -notmatch '^([01][0-9]|2[0-3]):[0-5][0-9]$') {
    throw "Horario invalido. Use HH:mm, por exemplo 03:00."
}
$scriptPath = Join-Path $PSScriptRoot 'backup-docker.ps1'
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "Script de backup nao encontrado."
}
$taskName = 'AutoFlow - Backup Diario'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    throw "A tarefa ja existe: $taskName. Revise-a no Agendador de Tarefas antes de altera-la."
}
$atTime = [DateTime]::Today.AddHours([int]$At.Substring(0, 2)).AddMinutes([int]$At.Substring(3, 2))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument (
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '"'
)
$trigger = New-ScheduledTaskTrigger -Daily -At $atTime
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $taskName -Description 'Backup do Auto Flow, verificado; para e reinicia apenas o app Docker.' -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Host "Tarefa $taskName criada para $At, apenas quando o usuario estiver logado."
Write-Host "O Docker Desktop precisa estar ativo. Confira o resultado no Agendador de Tarefas."
