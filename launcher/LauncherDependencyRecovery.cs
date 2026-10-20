namespace AutoFlowLauncher;

// npm ci removes node_modules before reinstalling. Keep the existing working
// dependencies until a fully staged install has succeeded, then swap folders
// on the same volume. A crash between the two moves can be recovered at boot.
internal static class LauncherDependencyRecovery
{
    private const string RecoveryFolder = ".autoflow-launcher-recovery";
    private const string PreviousFolder = "node_modules.previous";
    private static string RecoveryPath(string repository) => Path.Combine(repository, RecoveryFolder);
    private static string ActivePath(string repository) => Path.Combine(repository, "node_modules");
    private static string PreviousPath(string repository) => Path.Combine(RecoveryPath(repository), PreviousFolder);

    internal static bool RecoverInterruptedSwap(string repository)
    {
        var previous = PreviousPath(repository);
        var active = ActivePath(repository);
        if (!Directory.Exists(previous) || Directory.Exists(active)) return false;
        Directory.Move(previous, active);
        return true;
    }

    internal static async Task InstallAsync(string repository, Func<string, Task> installInStage)
    {
        if (installInStage is null) throw new ArgumentNullException(nameof(installInStage));
        var recovery = RecoveryPath(repository);
        Directory.CreateDirectory(recovery);
        RecoverInterruptedSwap(repository);
        var previous = PreviousPath(repository);
        if (Directory.Exists(previous))
            throw new IOException(
                "Há dependências anteriores preservadas após uma falha de inicialização. " +
                "Não serão sobrescritas. Verifique o diagnóstico e a pasta de recuperação.");

        var stage = Path.Combine(recovery, "stage-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            foreach (var name in new[] { "package.json", "package-lock.json" })
            {
                var source = Path.Combine(repository, name);
                if (!File.Exists(source))
                    throw new FileNotFoundException("Manifesto de dependências ausente.", source);
                File.Copy(source, Path.Combine(stage, name));
            }
            // Preserve any custom npm registry settings without changing them.
            var npmrc = Path.Combine(repository, ".npmrc");
            if (File.Exists(npmrc))
                File.Copy(npmrc, Path.Combine(stage, ".npmrc"));

            // Never execute npm ci against the current node_modules directory.
            await installInStage(stage);
            var stagedModules = Path.Combine(stage, "node_modules");
            if (!Directory.Exists(stagedModules))
                throw new IOException("npm ci terminou sem criar node_modules no staging.");

            var active = ActivePath(repository);
            var movedPrevious = false;
            if (Directory.Exists(active))
            {
                Directory.Move(active, previous);
                movedPrevious = true;
            }
            try
            {
                Directory.Move(stagedModules, active);
            }
            catch
            {
                if (movedPrevious && !Directory.Exists(active) && Directory.Exists(previous))
                    Directory.Move(previous, active);
                throw;
            }
            // Keep the previous dependencies until the API and panel pass their
            // readiness checks. Do not silently restore an old dependency tree
            // after a source update, as it may be incompatible with the new code.
        }
        finally
        {
            // A failed staged installation must not disturb the live dependency tree.
            if (Directory.Exists(stage))
            {
                try { Directory.Delete(stage, recursive: true); }
                catch (IOException) { /* diagnostics remain; no live files affected */ }
                catch (UnauthorizedAccessException) { }
            }
        }
    }

    internal static bool CompleteSuccessfulStartup(string repository)
    {
        var previous = PreviousPath(repository);
        if (!Directory.Exists(previous)) return false;
        if (!Directory.Exists(ActivePath(repository)))
            throw new IOException("As dependências atuais não existem; o backup foi preservado.");
        Directory.Delete(previous, recursive: true);
        return true;
    }

    internal static bool HasPreservedPrevious(string repository) =>
        Directory.Exists(PreviousPath(repository));
}
