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
        using var vite = new TcpListener(IPAddress.IPv6Loopback, 0);
        vite.Start();
        var port = ((IPEndPoint)vite.LocalEndpoint).Port;
        if (!await InvokeAsync("PortUsedAsync", port))
            throw new Exception("IPv6-only localhost listener was not detected.");

        // The launcher now relies on HTTP instead of an open TCP port to
        // establish readiness. Exercise the very method used at startup.
        var serverTask = Task.Run(async () =>
        {
            using var connection = await vite.AcceptTcpClientAsync();
            using var stream = connection.GetStream();
            var request = new byte[2048];
            await stream.ReadAsync(request);
            var bytes = Encoding.ASCII.GetBytes(
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
            await stream.WriteAsync(bytes);
        });
        if (!await InvokeAsync("HttpReadyAsync", $"http://[::1]:{port}/"))
            throw new Exception("HTTP readiness check failed for an IPv6-only service.");
        await serverTask.WaitAsync(TimeSpan.FromSeconds(5));
        vite.Stop();
        Console.WriteLine("OK: IPv6 localhost port and HTTP readiness detected.");
    }
}
