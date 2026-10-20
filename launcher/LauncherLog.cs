using System.Text;

namespace AutoFlowLauncher;

// Keep diagnostics useful without growing indefinitely on long-running PCs.
// Only the active file and one rotated copy are retained.
internal static class LauncherLog
{
    private static readonly object Gate = new();
    internal const long MaximumBytes = 2 * 1024 * 1024;

    internal static void Append(string path, string line, long maximumBytes = MaximumBytes)
    {
        if (maximumBytes < 1024)
            throw new ArgumentOutOfRangeException(nameof(maximumBytes));

        // A single malformed npm/Vite line must not exhaust the launcher log.
        if (line.Length > 8192)
            line = line[..8192] + " [linha truncada]" + Environment.NewLine;

        lock (Gate)
        {
            var folder = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(folder))
                Directory.CreateDirectory(folder);

            if (File.Exists(path) &&
                new FileInfo(path).Length + Encoding.UTF8.GetByteCount(line) > maximumBytes)
            {
                File.Move(path, path + ".1", overwrite: true);
            }
            File.AppendAllText(path, line, Encoding.UTF8);
        }
    }
}
