using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace AutoFlowLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new LauncherForm());
    }
}

internal sealed class LauncherForm : Form
{
    private readonly Label _status = new();
    private readonly TextBox _log = new();
    private readonly Button _open = new();
    private readonly ProgressBar _progress = new();
    private readonly Label _progressCaption = new();
    private readonly Label _elapsedCaption = new();
    private readonly Stopwatch _startupWatch = new();
    private readonly System.Windows.Forms.Timer _elapsedTimer = new() { Interval = 1000 };
    private readonly CancellationTokenSource _lifetime = new();
    private Process? _server;
    private bool _serverOwned;

    public LauncherForm()
    {
        Text = "AutoFlow | Atualizar e iniciar";
        Size = new Size(760, 560);
        MinimumSize = new Size(590, 480);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(13, 25, 24);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 7,
            Padding = new Padding(22),
            BackColor = BackColor
        };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 21));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 37));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));

        var header = new Label
        {
            Text = "AutoFlow  |  Inicializador",
            Font = new Font("Segoe UI", 18, FontStyle.Bold),
            ForeColor = Color.FromArgb(50, 209, 165),
            TextAlign = ContentAlignment.MiddleLeft,
            Dock = DockStyle.Fill
        };
        _status.Text = "Aguardando verificação...";
        _status.ForeColor = Color.FromArgb(212, 226, 225);
        _status.TextAlign = ContentAlignment.MiddleLeft;
        _status.Dock = DockStyle.Fill;

        _progressCaption.Text = "0%  ·  Verificação inicial";
        _progressCaption.ForeColor = Color.FromArgb(211, 229, 223);
        _progressCaption.Dock = DockStyle.Fill;
        _progressCaption.TextAlign = ContentAlignment.MiddleLeft;
        _progressCaption.Font = new Font("Segoe UI", 9, FontStyle.Bold);

        _progress.Dock = DockStyle.Fill;
        _progress.Maximum = 100;
        _progress.Minimum = 0;
        _progress.Value = 0;
        _progress.Style = ProgressBarStyle.Continuous;

        _elapsedCaption.Dock = DockStyle.Fill;
        _elapsedCaption.TextAlign = ContentAlignment.MiddleLeft;
        _elapsedCaption.ForeColor = Color.FromArgb(157, 193, 184);
        _elapsedCaption.Font = new Font("Segoe UI", 9);
        _elapsedCaption.Text = "Decorrido: 00:00  ·  Previsão inicial: 1–4 min (varia por computador)";

        _elapsedTimer.Tick += (_, _) => RefreshElapsedCaption();

        _log.Multiline = true;
        _log.ReadOnly = true;
        _log.ScrollBars = ScrollBars.Vertical;
        _log.BackColor = Color.FromArgb(21, 39, 37);
        _log.ForeColor = Color.FromArgb(225, 239, 237);
        _log.Font = new Font("Consolas", 10);
        _log.Dock = DockStyle.Fill;
        _log.BorderStyle = BorderStyle.FixedSingle;
        _log.TabStop = false;

        var actions = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            Dock = DockStyle.Fill,
            Padding = new Padding(0, 12, 0, 0)
        };
        var stop = new Button
        {
            Text = "Encerrar AutoFlow",
            AutoSize = true,
            Height = 35,
            BackColor = Color.FromArgb(51, 67, 66),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat
        };
        stop.FlatAppearance.BorderSize = 0;
        stop.Click += (_, _) => Close();

        _open.Text = "Abrir painel";
        _open.AutoSize = true;
        _open.Height = 35;
        _open.BackColor = Color.FromArgb(34, 183, 137);
        _open.ForeColor = Color.FromArgb(8, 27, 23);
        _open.Font = new Font("Segoe UI", 10, FontStyle.Bold);
        _open.FlatStyle = FlatStyle.Flat;
        _open.FlatAppearance.BorderSize = 0;
        _open.Enabled = false;
        _open.Click += (_, _) => OpenPanel();

        actions.Controls.Add(stop);
        actions.Controls.Add(_open);
        layout.Controls.Add(header, 0, 0);
        layout.Controls.Add(_status, 0, 1);
        layout.Controls.Add(_progressCaption, 0, 2);
        layout.Controls.Add(_progress, 0, 3);
        layout.Controls.Add(_elapsedCaption, 0, 4);
        layout.Controls.Add(_log, 0, 5);
        layout.Controls.Add(actions, 0, 6);
        Controls.Add(layout);

        Shown += async (_, _) =>
        {
            _startupWatch.Start();
            _elapsedTimer.Start();
            await InitializeAsync();
        };
        FormClosing += (_, _) =>
        {
            _lifetime.Cancel();
            _elapsedTimer.Stop();
            if (_serverOwned)
            {
                try
                {
                    if (_server is { HasExited: false })
                        _server.Kill(entireProcessTree: true);
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { }
            }
        };
    }

    private void Report(string message)
    {
        if (IsDisposed || Disposing) return;
        if (InvokeRequired)
        {
            try { BeginInvoke(() => Report(message)); }
            catch (InvalidOperationException) { }
            return;
        }

        // Vite emits ANSI cursor/color sequences which are unreadable in WinForms.
        message = Regex.Replace(message, @"\x1B\[[0-?]*[ -/]*[@-~]", "");
        string line = $"[{DateTime.Now:HH:mm:ss}] {message}{Environment.NewLine}";
        _log.AppendText(line);
        if (_log.TextLength > 28000)
            _log.Text = _log.Text[^18000..];

        // Local diagnostic output is kept outside the Git repository.
        try
        {
            var folder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "AutoFlow");
            Directory.CreateDirectory(folder);
            File.AppendAllText(Path.Combine(folder, "launcher.log"), line);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private void Status(string text)
    {
        if (IsDisposed || Disposing) return;
        if (InvokeRequired)
        {
            try { BeginInvoke(() => Status(text)); }
            catch (InvalidOperationException) { }
            return;
        }
        _status.Text = text;
    }

    private static string? FindRepository()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var candidates = new[]
        {
            Environment.GetEnvironmentVariable("AUTOFLOW_REPO_PATH"),
            Path.Combine(home, "autoflow-vehicle-poster"),
            AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar),
        };
        foreach (var candidate in candidates)
        {
            if (string.IsNullOrWhiteSpace(candidate)) continue;
            var path = Path.GetFullPath(candidate);
            if (Directory.Exists(Path.Combine(path, ".git")) &&
                File.Exists(Path.Combine(path, "package.json")))
                return path;
        }
        return null;
    }

    private static async Task<bool> PortUsedAsync(int port)
    {
        using var client = new TcpClient();
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(450));
        try
        {
            await client.ConnectAsync(IPAddress.Loopback, port, timeout.Token);
            return true;
        }
        catch (SocketException) { return false; }
        catch (OperationCanceledException) { return false; }
    }

    private sealed record CommandResult(int ExitCode, string Output, string Error)
    {
        public bool Ok => ExitCode == 0;
        public string Summary => (string.IsNullOrWhiteSpace(Error) ? Output : Error).Trim();
    }

    private async Task<CommandResult> ExecuteAsync(
        string directory, string command, string[] arguments, TimeSpan timeout)
    {
        using var process = new Process();
        process.StartInfo = new ProcessStartInfo(command)
        {
            WorkingDirectory = directory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var value in arguments) process.StartInfo.ArgumentList.Add(value);

        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        cancellation.CancelAfter(timeout);
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Processo não iniciado.");
            var output = process.StandardOutput.ReadToEndAsync(cancellation.Token);
            var error = process.StandardError.ReadToEndAsync(cancellation.Token);
            await process.WaitForExitAsync(cancellation.Token);
            return new CommandResult(process.ExitCode, await output, await error);
        }
        catch
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
            throw;
        }
    }

    private Task<CommandResult> GitAsync(string directory, params string[] arguments) =>
        ExecuteAsync(directory, "git", arguments, TimeSpan.FromSeconds(50));

    private Task<CommandResult> NpmAsync(string directory, string instruction) =>
        ExecuteAsync(directory, "cmd.exe", ["/d", "/c", instruction], TimeSpan.FromMinutes(10));

    private async Task InitializeAsync()
    {
        try
        {
            var repository = FindRepository();
            if (repository is null)
            {
                Status("Instalação local não encontrada");
                Report("Pasta esperada: %USERPROFILE%\\autoflow-vehicle-poster");
                Report("Primeiro clone o repositório. Não foi criado nenhum banco novo.");
                return;
            }
            Report("Projeto: " + repository);

            // Do not overwrite or race an existing running server or its database.
            var apiUsed = await PortUsedAsync(3333);
            var panelUsed = await PortUsedAsync(5173);
            if (apiUsed || panelUsed)
            {
                if (apiUsed && panelUsed)
                {
                    Status("AutoFlow já está em execução");
                    Report("Feche a execução anterior antes de atualizar o código.");
                    _open.Enabled = true;
                }
                else
                {
                    Status("Uma porta está ocupada; inicialização pausada");
                    Report("Verifique os programas usando 3333 ou 5173 e tente novamente.");
                }
                return;
            }

            Status("Verificando Git, Node.js e arquivos locais...");
            var gitVersion = await GitAsync(repository, "--version");
            if (!gitVersion.Ok)
                throw new InvalidOperationException("O Git não está disponível no PATH.");

            var node = await ExecuteAsync(repository, "node", ["--version"],
                TimeSpan.FromSeconds(15));
            if (!node.Ok || !Version.TryParse(node.Output.Trim().TrimStart('v'), out var version) ||
                version.Major < 22 || (version.Major == 22 && version.Minor < 18))
                throw new InvalidOperationException("Instale Node.js 22.18+ ou 24 LTS.");

            bool updated = false;
            var currentBranch = await GitAsync(repository, "branch", "--show-current");
            var dirty = await GitAsync(repository, "status", "--porcelain", "--untracked-files=no");
            if (!currentBranch.Ok || !dirty.Ok)
            {
                Report("Git não pôde verificar a instalação. Mantendo a versão local.");
            }
            else if (currentBranch.Output.Trim() != "main")
            {
                Report("Branch atual: " + currentBranch.Output.Trim() +
                    ". Nenhuma alteração de branch será feita automaticamente.");
            }
            else if (!string.IsNullOrWhiteSpace(dirty.Output))
            {
                Report("Existem modificações locais. A atualização foi ignorada para protegê-las.");
                Report("Use 'git status' no PowerShell para revisar antes de atualizar.");
            }
            else
            {
                Status("Consultando atualizações no GitHub...");
                var fetched = await GitAsync(repository, "fetch", "origin", "main");
                if (!fetched.Ok)
                {
                    Report("GitHub indisponível ou acesso negado. Usando a versão instalada.");
                    Report(fetched.Summary.Length > 300 ? fetched.Summary[..300] : fetched.Summary);
                }
                else
                {
                    var current = await GitAsync(repository, "rev-parse", "HEAD");
                    var remote = await GitAsync(repository, "rev-parse", "FETCH_HEAD");
                    if (current.Ok && remote.Ok && current.Output.Trim() != remote.Output.Trim())
                    {
                        var ancestor = await GitAsync(repository,
                            "merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD");
                        if (!ancestor.Ok)
                        {
                            Report("O histórico local divergiu. Nenhum reset nem sobrescrita.");
                        }
                        else
                        {
                            Status("Aplicando atualização de código (fast-forward)...");
                            var merge = await GitAsync(repository, "merge", "--ff-only", "FETCH_HEAD");
                            if (!merge.Ok)
                            {
                                Report("Atualização não aplicada: " + merge.Summary);
                                Report("O AutoFlow local será iniciado sem mudar seus arquivos.");
                            }
                            else
                            {
                                updated = true;
                                Report("Código atualizado com sucesso pelo GitHub.");
                            }
                        }
                    }
                    else if (current.Ok && remote.Ok)
                    {
                        Report("Código já está atualizado.");
                    }
                    else
                    {
                        Report("Não foi possível comparar versões; mantendo arquivos locais.");
                    }
                }
            }

            if (updated || !Directory.Exists(Path.Combine(repository, "node_modules")))
            {
                Status("Instalando dependências do projeto...");
                Report("Executando npm ci sem modificar banco, fotos ou .env...");
                var install = await NpmAsync(repository, "npm ci --no-audit --no-fund");
                if (!install.Ok)
                    throw new InvalidOperationException("npm ci falhou: " + Tail(install.Summary));
                Report("Dependências instaladas.");
            }

            if (updated || !File.Exists(Path.Combine(repository, "dist", "extension", "manifest.json")))
            {
                Status("Preparando extensão do Brave...");
                var extension = await NpmAsync(repository, "npm run build:extension");
                if (!extension.Ok)
                    throw new InvalidOperationException(
                        "Compilação da extensão falhou: " + Tail(extension.Summary));
                Report("Extensão atualizada. Recarregue-a em brave://extensions se já estava instalada.");
            }

            Status("Iniciando API e painel...");
            _server = new Process
            {
                StartInfo = new ProcessStartInfo("cmd.exe")
                {
                    Arguments = "/d /c npm run dev",
                    WorkingDirectory = repository,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                },
                EnableRaisingEvents = true
            };
            _server.OutputDataReceived += (_, line) =>
            {
                if (!string.IsNullOrWhiteSpace(line.Data)) Report(line.Data);
            };
            _server.ErrorDataReceived += (_, line) =>
            {
                if (!string.IsNullOrWhiteSpace(line.Data)) Report(line.Data);
            };
            _server.Exited += (_, _) => Status("A execução do AutoFlow foi encerrada.");
            if (!_server.Start()) throw new InvalidOperationException("npm run dev não iniciou.");
            _serverOwned = true;
            _server.BeginOutputReadLine();
            _server.BeginErrorReadLine();

            using var timer = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
            timer.CancelAfter(TimeSpan.FromSeconds(90));
            while (!timer.IsCancellationRequested)
            {
                if (_server.HasExited)
                    throw new InvalidOperationException(
                        "O servidor encerrou durante a inicialização. Consulte o registro abaixo.");
                if (await PortUsedAsync(3333) && await PortUsedAsync(5173))
                {
                    Status("AutoFlow pronto — painel e API ativos");
                    Report("Iniciado com sucesso. Mantenha esta janela aberta.");
                    _open.Enabled = true;
                    OpenPanel();
                    return;
                }
                await Task.Delay(600, timer.Token);
            }
            throw new TimeoutException(
                "A API ou o painel não iniciaram em 90 segundos. Verifique o registro de execução.");
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception error)
        {
            Status("Não foi possível iniciar o AutoFlow");
            Report(error.Message);
        }
    }

    private static string Tail(string value) =>
        value.Length > 700 ? value[^700..] : value;

    private void OpenPanel()
    {
        try
        {
            Process.Start(new ProcessStartInfo("http://localhost:5173")
            {
                UseShellExecute = true
            });
        }
        catch (Exception error)
        {
            Report("Não foi possível abrir o navegador: " + error.Message);
        }
    }
}
