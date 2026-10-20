using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;

namespace AutoFlowLauncher;

internal static class LauncherNetworkSmoke
{
    private static async Task<bool> InvokeAsync(string name, params object[] args)
    {
        var method = typeof(LauncherForm).GetMethod(
            name, BindingFlags.NonPublic | BindingFlags.Static);
        if (method is null) throw new InvalidOperationException("Missing method: " + name);
        return await (Task<bool>)method.Invoke(null, args)!;
    }

    [STAThread]
    private static async Task Main()
    {
        // This reproduces the actual Windows issue: Vite binds only ::1,
        // so a probe against 127.0.0.1 alone returns a false negative.
        var vite = new TcpListener(IPAddress.IPv6Loopback, 0);
        vite.Start();
        var port = ((IPEndPoint)vite.LocalEndpoint).Port;
        if (!await InvokeAsync("PortUsedAsync", port))
            throw new Exception("IPv6-only localhost listener was not detected.");
        // The TCP probe connects and closes without sending an HTTP request.
        // Drain that connection before serving the readiness HTTP request.
        using (var probe = await vite.AcceptTcpClientAsync())
        {
        }

        // The launcher now relies on HTTP instead of an open TCP port to
        // establish readiness. Exercise the very method used at startup.
        var serverTask = Task.Run(async () =>
        {
            using var connection = await vite.AcceptTcpClientAsync();
            using var stream = connection.GetStream();
            var request = new byte[2048];
            await stream.ReadAtLeastAsync(request.AsMemory(), 1, throwOnEndOfStream: true);
            var bytes = Encoding.ASCII.GetBytes(
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
            await stream.WriteAsync(bytes);
        });
        if (!await InvokeAsync("HttpReadyAsync", $"http://[::1]:{port}/"))
            throw new Exception("HTTP readiness check failed for an IPv6-only service.");
        await serverTask.WaitAsync(TimeSpan.FromSeconds(5));
        vite.Stop();

        // Safe boot decisions: reuse a healthy half-instance but never take
        // over an unrelated listener, or silently change code under a server.
        var resolver = typeof(LauncherForm).GetMethod(
            "SelectStartCommand", BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new Exception("Missing startup resolution logic.");
        string Resolve(bool apiPort, bool webPort, bool apiOk, bool webOk) =>
            (string)resolver.Invoke(null, [apiPort, webPort, apiOk, webOk])!;
        if (Resolve(false, false, false, false) != "npm run dev")
            throw new Exception("Clean startup incorrectly resolved.");
        if (Resolve(true, false, true, false) != "npm run dev:web")
            throw new Exception("API-only recovery failed.");
        if (Resolve(false, true, false, true) != "npm run dev:api")
            throw new Exception("Panel-only recovery failed.");
        if (Resolve(true, true, true, true) != "already-running")
            throw new Exception("Two active services must be reused, not duplicated.");
        if (Resolve(true, false, false, false) != "blocked" ||
            Resolve(false, true, false, false) != "blocked" ||
            Resolve(true, true, true, false) != "blocked" ||
            Resolve(true, true, false, true) != "blocked")
            throw new Exception("Unknown or unresponsive port cannot be replaced.");

        // A process from another application must never be terminated simply
        // because it listens on the same port as our development server.
        var scanBefore = await AutoFlowProcessManager.InspectAsync(Environment.CurrentDirectory);
        if (!scanBefore.HasListeners)
        {
            var foreign = new TcpListener(IPAddress.Loopback, 3333);
            try
            {
                foreign.Start();
                var scan = await AutoFlowProcessManager.InspectAsync(Environment.CurrentDirectory);
                if (scan.Safe || !scan.Servers.Any(entry => entry.Port == 3333))
                    throw new Exception("Foreign process on 3333 was not blocked.");
            }
            finally
            {
                foreign.Stop();
            }
        }

        // Another launcher thread must not take the same installation lock.
        var mutexName = @"Local\AutoFlow.Launcher.Smoke." + Guid.NewGuid().ToString("N");
        using (var first = LauncherInstanceGuard.TryAcquire(mutexName))
        {
            if (!first.Acquired) throw new Exception("First launcher cannot acquire its mutex.");
            // A Windows mutex is owned by a *thread*. Do not await while
            // holding the first lock, or this async smoke-test may resume on
            // another thread and incorrectly release it from there.
            var secondAcquired = Task.Run(() =>
            {
                using var second = LauncherInstanceGuard.TryAcquire(mutexName);
                return second.Acquired;
            }).GetAwaiter().GetResult();
            if (secondAcquired)
                throw new Exception("A concurrent launcher acquired an occupied mutex.");
        }
        using (var afterClose = LauncherInstanceGuard.TryAcquire(mutexName))
        {
            if (!afterClose.Acquired)
                throw new Exception("Launcher mutex was not released after exit.");
        }

        // Rotation must retain current diagnostics with bounded on-disk size.
        var logFolder = Path.Combine(Path.GetTempPath(),
            "autoflow-launcher-smoke-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(logFolder);
            var logPath = Path.Combine(logFolder, "launcher.log");
            for (var i = 0; i < 40; i++)
                LauncherLog.Append(logPath, $"entry-{i:D2}: " + new string('x', 400) + "\n", 4096);
            if (!File.Exists(logPath + ".1"))
                throw new Exception("Log file was not rotated.");
            if (new FileInfo(logPath).Length > 4096 ||
                new FileInfo(logPath + ".1").Length > 4096)
                throw new Exception("Launcher log exceeded the configured byte limit.");
            if (!File.ReadAllText(logPath).Contains("entry-39"))
                throw new Exception("The most recent diagnostic entry was not retained.");
        }
        finally
        {
            if (Directory.Exists(logFolder))
                Directory.Delete(logFolder, recursive: true);
        }

        // Dependency installation must not clobber a working node_modules
        // when staged npm ci fails. Recover a crash between atomic moves.
        var dependencyRoot = Path.Combine(Path.GetTempPath(),
            "autoflow-dependency-smoke-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(dependencyRoot);
            File.WriteAllText(Path.Combine(dependencyRoot, "package.json"), "{}");
            File.WriteAllText(Path.Combine(dependencyRoot, "package-lock.json"), "{}");
            var active = Path.Combine(dependencyRoot, "node_modules");
            Directory.CreateDirectory(active);
            File.WriteAllText(Path.Combine(active, "old.txt"), "original");
            var failed = false;
            try
            {
                await LauncherDependencyRecovery.InstallAsync(dependencyRoot, _ =>
                    throw new IOException("simulated npm ci failure"));
            }
            catch (IOException) { failed = true; }
            if (!failed || !File.Exists(Path.Combine(active, "old.txt")))
                throw new Exception("Failed staging modified existing dependencies.");

            await LauncherDependencyRecovery.InstallAsync(dependencyRoot, stage =>
            {
                var modules = Path.Combine(stage, "node_modules");
                Directory.CreateDirectory(modules);
                File.WriteAllText(Path.Combine(modules, "new.txt"), "updated");
                return Task.CompletedTask;
            });
            if (!File.Exists(Path.Combine(active, "new.txt")) ||
                !LauncherDependencyRecovery.HasPreservedPrevious(dependencyRoot))
                throw new Exception("Completed staging did not preserve old dependencies.");
            if (!LauncherDependencyRecovery.CompleteSuccessfulStartup(dependencyRoot) ||
                LauncherDependencyRecovery.HasPreservedPrevious(dependencyRoot))
                throw new Exception("Previous dependencies not cleaned after readiness.");

            var recovery = Path.Combine(dependencyRoot,
                ".autoflow-launcher-recovery", "node_modules.previous");
            Directory.Move(active, recovery);
            if (!LauncherDependencyRecovery.RecoverInterruptedSwap(dependencyRoot) ||
                !File.Exists(Path.Combine(active, "new.txt")))
                throw new Exception("Interrupted folder swap could not be recovered.");
        }
        finally
        {
            if (Directory.Exists(dependencyRoot))
                Directory.Delete(dependencyRoot, recursive: true);
        }

        Console.WriteLine("OK: IPv6 HTTP, startup decisions, foreign processes, single instance, log rotation and dependency staging.");
    }
}
