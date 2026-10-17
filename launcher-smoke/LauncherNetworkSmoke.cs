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

        Console.WriteLine("OK: IPv6 HTTP and safe partial AutoFlow recovery decisions.");
    }
}
