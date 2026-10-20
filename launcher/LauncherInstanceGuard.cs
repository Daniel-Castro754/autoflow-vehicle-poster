using System.Threading;

namespace AutoFlowLauncher;

// A named mutex prevents two launchers in the same Windows session from
// updating node_modules or starting the API/Vite concurrently.
// The lock is owned and released by the UI thread, never by a background task.
internal sealed class LauncherInstanceGuard : IDisposable
{
    private readonly Mutex _mutex;
    private bool _ownsMutex;

    private LauncherInstanceGuard(Mutex mutex, bool ownsMutex)
    {
        _mutex = mutex;
        _ownsMutex = ownsMutex;
    }

    internal bool Acquired => _ownsMutex;

    internal static LauncherInstanceGuard TryAcquire(string name)
    {
        var mutex = new Mutex(initiallyOwned: false, name);
        bool acquired;
        try
        {
            acquired = mutex.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            // A previous launcher crashed. Its OS mutex is now available.
            acquired = true;
        }
        return new LauncherInstanceGuard(mutex, acquired);
    }

    public void Dispose()
    {
        if (_ownsMutex)
        {
            _mutex.ReleaseMutex();
            _ownsMutex = false;
        }
        _mutex.Dispose();
    }
}
