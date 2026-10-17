using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace AutoFlowLauncher;

// Only processes listening on AutoFlow ports AND linked to this repository's
// node.exe process tree can be considered for termination. A foreign listener,
// missing process metadata or changed PID aborts the entire operation.
internal static class AutoFlowProcessManager
{
    internal sealed record ServerProcess(int Port, int ListenerPid, int StopPid, long StartTicks);
    internal sealed record Inspection(bool Safe, string Reason, IReadOnlyList<ServerProcess> Servers)
    {
        public bool HasListeners => Servers.Count > 0;
    }

    private static string InspectionScript(string repo)
    {
        var quoted = repo.Replace("'", "''");
        return $$"""
        $ErrorActionPreference = 'Stop'
        $root = '{{quoted}}'.TrimEnd('\')
        $output = @()
        $unsafe = $false
        foreach ($port in @(3333, 5173)) {
          $connections = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
          foreach ($listenerPid in $connections) {
            $currentId = [int]$listenerPid
            $chain = @()
            for ($i = 0; $i -lt 14 -and $currentId -gt 0; $i++) {
              $entry = Get-CimInstance Win32_Process -Filter "ProcessId=$currentId" -ErrorAction SilentlyContinue
              if ($null -eq $entry) { break }
              $chain += $entry
              if ([int]$entry.ParentProcessId -eq $currentId) { break }
              $currentId = [int]$entry.ParentProcessId
            }
            $head = $chain | Select-Object -First 1
            $matching = @($chain | Where-Object {
              $_.Name -ieq 'node.exe' -and $_.CommandLine -and
              $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
            })
            $trusted = $head -and $head.Name -ieq 'node.exe' -and $matching.Count -gt 0
            if (-not $trusted) {
              $unsafe = $true
              $output += [pscustomobject]@{
                port = $port; listenerPid = [int]$listenerPid
                stopPid = 0; startTicks = 0
              }
              continue
            }
            # Prefer the oldest linked node parent (often concurrently).
            # Its descendants contain API + Vite; no unrelated parent shell
            # such as PowerShell, explorer or cmd.exe is ever terminated.
            $target = $matching[-1]
            $output += [pscustomobject]@{
              port = $port
              listenerPid = [int]$listenerPid
              stopPid = [int]$target.ProcessId
              startTicks = [long]$target.CreationDate.ToUniversalTime().Ticks
            }
          }
        }
        [pscustomobject]@{ safe = (-not $unsafe); servers = @($output) } |
          ConvertTo-Json -Depth 5 -Compress
        """;
    }

    internal static async Task<Inspection> InspectAsync(string repository)
    {
        try
        {
            var script = InspectionScript(Path.GetFullPath(repository));
            var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo("powershell.exe")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    ArgumentList = { "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded }
                }
            };
            if (!process.Start()) return new Inspection(false, "Não foi possível abrir o PowerShell.", []);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(16));
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var error = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            var text = await output;
            var diagnostic = await error;
            if (process.ExitCode != 0)
                return new Inspection(false, "Não foi possível identificar os processos: " +
                    diagnostic.Trim().Split('\n').FirstOrDefault(), []);
            using var json = JsonDocument.Parse(text);
            var root = json.RootElement;
            var servers = root.GetProperty("servers").EnumerateArray()
                .Select(item => new ServerProcess(
                    item.GetProperty("port").GetInt32(),
                    item.GetProperty("listenerPid").GetInt32(),
                    item.GetProperty("stopPid").GetInt32(),
                    item.GetProperty("startTicks").GetInt64())).ToArray();
            bool safe = root.GetProperty("safe").GetBoolean() &&
                servers.All(item => item.StopPid > 0 && item.StartTicks > 0);
            return new Inspection(safe,
                safe ? "" : "Uma porta pertence a um processo não identificado como AutoFlow. Nenhum processo será encerrado.",
                servers);
        }
        catch (Exception error)
        {
            return new Inspection(false, "Falha ao inspecionar os processos: " + error.Message, []);
        }
    }

    internal static async Task<(bool Success, string Message)> StopVerifiedAsync(
        string repository, Inspection approved)
    {
        var current = await InspectAsync(repository);
        if (!approved.Safe || !current.Safe)
            return (false, current.Reason.Length > 0 ? current.Reason : "A identificação não é confiável.");
        var original = approved.Servers
            .OrderBy(x => x.Port).ThenBy(x => x.ListenerPid)
            .Select(x => (x.Port, x.ListenerPid, x.StopPid, x.StartTicks)).ToArray();
        var fresh = current.Servers
            .OrderBy(x => x.Port).ThenBy(x => x.ListenerPid)
            .Select(x => (x.Port, x.ListenerPid, x.StopPid, x.StartTicks)).ToArray();
        if (!original.SequenceEqual(fresh))
            return (false, "Os processos mudaram durante a confirmação. Nenhum foi encerrado.");

        foreach (var target in current.Servers
            .Select(x => (x.StopPid, x.StartTicks)).Distinct())
        {
            try
            {
                using var process = Process.GetProcessById(target.StopPid);
                if (Math.Abs((process.StartTime.ToUniversalTime().Ticks - target.StartTicks) /
                    (double)TimeSpan.TicksPerSecond) > 2)
                    return (false, "A identificação do processo mudou. Nenhum outro processo será encerrado.");
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token);
            }
            catch (ArgumentException)
            {
                // The identified process has already exited; verify ports below.
            }
            catch (Exception error)
            {
                return (false, "Não foi possível encerrar a instância identificada: " + error.Message);
            }
        }

        for (var attempt = 0; attempt < 20; attempt++)
        {
            var after = await InspectAsync(repository);
            if (after.Servers.Count == 0 && after.Safe) return (true, "Serviços encerrados.");
            if (!after.Safe) return (false, "Um serviço desconhecido ocupou a porta. Atualização interrompida.");
            await Task.Delay(400);
        }
        return (false, "As portas não ficaram livres. Verifique se há outro iniciador automático em execução.");
    }
}
