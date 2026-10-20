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
        // Keep only one launcher per interactive Windows session. A second
        // window must not race the first through git fetch, npm ci and boot.
        using var instance = LauncherInstanceGuard.TryAcquire(@"Local\AutoFlow.Launcher");
        if (!instance.Acquired)
        {
            MessageBox.Show(
                "O inicializador do AutoFlow já está aberto.\n\n" +
                "Use a janela existente para abrir o painel ou atualizar.",
                "AutoFlow | Já está em execução",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        Application.Run(new LauncherForm());
    }
}

internal sealed class LauncherForm : Form
{
    private readonly Label _status = new();
    private readonly TextBox _log = new();
    private readonly Button _open = new();
    private readonly Button _update = new();
    private bool _updating;
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
        Text = "AutoFlow | Atualizar e iniciar · v1.3";
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
            Text = "AutoFlow  |  Inicializador v1.3",
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

        _update.Text = "Atualizar e reiniciar";
        _update.AutoSize = true;
        _update.Height = 35;
        _update.BackColor = Color.FromArgb(44, 110, 96);
        _update.ForeColor = Color.White;
        _update.FlatStyle = FlatStyle.Flat;
        _update.FlatAppearance.BorderSize = 0;
        _update.Enabled = false;
        _update.Click += async (_, _) => await UpdateAndRestartAsync();

        actions.Controls.Add(stop);
        actions.Controls.Add(_update);
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

    private readonly List<double> _previousStartupTimes = new();

    private static string StartupHistoryPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "AutoFlow", "startup-times.json");

    private void LoadStartupHistory()
    {
        try
        {
            if (!File.Exists(StartupHistoryPath)) return;
            var times = JsonSerializer.Deserialize<List<double>>(File.ReadAllText(StartupHistoryPath));
            if (times is not null)
                _previousStartupTimes.AddRange(times.Where(n => double.IsFinite(n) && n > 0 && n < 3600).TakeLast(8));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (JsonException) { }
    }

    private static string Clock(TimeSpan span) =>
        $"{(int)span.TotalMinutes:00}:{span.Seconds:00}";

    private void RefreshElapsedCaption()
    {
        if (IsDisposed || Disposing) return;
        string history = _previousStartupTimes.Count == 0
            ? "Previsão inicial: 1–4 min (primeira instalação pode levar mais)"
            : $"Média neste PC: {Clock(TimeSpan.FromSeconds(_previousStartupTimes.Average()))} " +
              $"({_previousStartupTimes.Count} início(s))";
        _elapsedCaption.Text = $"Decorrido: {Clock(_startupWatch.Elapsed)}  ·  {history}";
    }

    private void SetProgress(int percentage, string phase)
    {
        _progress.Value = Math.Clamp(percentage, _progress.Value, 100);
        _progressCaption.Text = $"{_progress.Value}%  ·  {phase}";
        Status(phase);
        RefreshElapsedCaption();
    }

    private void FinishStartup()
    {
        _startupWatch.Stop();
        _elapsedTimer.Stop();
        SetProgress(100, "AutoFlow pronto — painel e API ativos");
        try
        {
            _previousStartupTimes.Add(_startupWatch.Elapsed.TotalSeconds);
            var folder = Path.GetDirectoryName(StartupHistoryPath)!;
            Directory.CreateDirectory(folder);
            File.WriteAllText(StartupHistoryPath,
                JsonSerializer.Serialize(_previousStartupTimes.TakeLast(8)));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
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
            LauncherLog.Append(Path.Combine(folder, "launcher.log"), line);
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

    // Vite may bind localhost to ::1 on Windows while the API uses 127.0.0.1.
    // Checking only IPv4 incorrectly reported both servers as unavailable.
    private static async Task<bool> PortUsedAsync(int port)
    {
        foreach (var address in new[] { IPAddress.Loopback, IPAddress.IPv6Loopback })
        {
            using var client = new TcpClient(address.AddressFamily);
            using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(400));
            try
            {
                await client.ConnectAsync(address, port, timeout.Token);
                return true;
            }
            catch (SocketException) { }
            catch (OperationCanceledException) { }
            catch (NotSupportedException) { }
        }
        return false;
    }

    private static readonly HttpClient HealthClient = new(
        new HttpClientHandler { UseProxy = false })
    {
        Timeout = TimeSpan.FromSeconds(2)
    };

    private static async Task<bool> HttpReadyAsync(string url)
    {
        try
        {
            using var response = await HealthClient.GetAsync(url);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) { return false; }
    }

    private static async Task<bool> PanelHttpReadyAsync(string url)
    {
        try
        {
            using var response = await HealthClient.GetAsync(url);
            if (!response.IsSuccessStatusCode) return false;
            var html = await response.Content.ReadAsStringAsync();
            return html.Contains("AutoFlow", StringComparison.OrdinalIgnoreCase) &&
                html.Contains("id=\"root\"", StringComparison.OrdinalIgnoreCase);
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) { return false; }
    }

    private static async Task<bool> PanelReadyAsync() =>
        await PanelHttpReadyAsync("http://localhost:5173/") ||
        await PanelHttpReadyAsync("http://127.0.0.1:5173/");
    private static async Task<bool> BrowserApiReadyAsync()
    {
        foreach (var url in new[]
        {
            "http://localhost:5173/api/health/ready",
            "http://127.0.0.1:5173/api/health/ready"
        })
        {
            try
            {
                using var response = await HealthClient.GetAsync(url);
                if (!response.IsSuccessStatusCode) continue;
                using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                if (json.RootElement.TryGetProperty("status", out var state) &&
                    state.GetString() == "ready") return true;
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) { }
            catch (JsonException) { }
        }
        return false;
    }

    // A healthy leftover half-instance may be reused safely. Never take over
    // a port which answers but does not match the AutoFlow app.
    private static string SelectStartCommand(
        bool apiPortUsed, bool panelPortUsed, bool apiReady, bool panelReady)
    {
        if (apiReady && panelReady) return "already-running";
        if ((apiPortUsed && !apiReady) || (panelPortUsed && !panelReady))
            return "blocked";
        if (apiReady && !panelPortUsed) return "npm run dev:web";
        if (panelReady && !apiPortUsed) return "npm run dev:api";
        return "npm run dev";
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
        catch (OperationCanceledException) when (!_lifetime.IsCancellationRequested)
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
            throw new TimeoutException(
                $"O comando '{command}' excedeu {timeout.TotalMinutes:0.#} minuto(s). Verifique a conexão e tente novamente.");
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
            LoadStartupHistory();
            SetProgress(5, "Localizando instalação do AutoFlow...");
            var repository = FindRepository();
            if (repository is null)
            {
                Status("Instalação local não encontrada");
                Report("Pasta esperada: %USERPROFILE%\\autoflow-vehicle-poster");
                Report("Primeiro clone o repositório. Não foi criado nenhum banco novo.");
                return;
            }
            Report("Projeto: " + repository);
            SetProgress(12, "Conferindo se a API e o painel já estão ativos...");

            // No automatic code or dependency updates while either service is
            // running, since this could replace files used by a live process.
            var apiPortUsed = await PortUsedAsync(3333);
            var panelPortUsed = await PortUsedAsync(5173);
            var apiReady = apiPortUsed &&
                await HttpReadyAsync("http://127.0.0.1:3333/health/ready");
            var panelReady = panelPortUsed && await PanelReadyAsync();
            var browserApiReady = apiReady && panelReady && await BrowserApiReadyAsync();
            var startCommand = SelectStartCommand(
                apiPortUsed, panelPortUsed, apiReady, panelReady);
            if (startCommand == "already-running" && !browserApiReady)
                startCommand = "blocked";
            Report($"API 3333: {(apiReady ? "AutoFlow saudável" : apiPortUsed ? "ocupada, sem resposta saudável" : "livre")}");
            Report($"Painel 5173: {(panelReady ? "AutoFlow saudável" : panelPortUsed ? "ocupada, sem painel válido" : "livre")}");
            if (apiReady && panelReady)
                Report(browserApiReady
                    ? "Proxy /api: funcionando."
                    : "Proxy /api: o navegador não consegue acessar a API pelo painel. Atualize/reinicie os serviços.");

            if (apiPortUsed || panelPortUsed) _update.Enabled = true;
            if (startCommand == "already-running")
            {
                SetProgress(100, "AutoFlow já está em execução");
                Report("API e painel estão disponíveis. Nenhuma segunda instância foi iniciada.");
                Report("Para atualizar o código, feche primeiro os processos em execução.");
                _elapsedTimer.Stop();
                _startupWatch.Stop();
                _open.Enabled = true;
                _update.Enabled = true;
                return;
            }
            if (startCommand == "blocked")
            {
                _elapsedTimer.Stop();
                _startupWatch.Stop();
                SetProgress(12, "Uma porta ocupada não respondeu como AutoFlow");
                Report("Por segurança não encerrei nem substituí processos existentes.");
                Report("No PowerShell, descubra o processo: Get-NetTCPConnection -State Listen -LocalPort 3333,5173 -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess");
                Report("Depois verifique cada PID: Get-CimInstance Win32_Process -Filter \"ProcessId=PID\" | Select-Object ProcessId,Name,CommandLine");
                Report("Feche apenas processos identificados como AutoFlow e abra este EXE novamente.");
                return;
            }
            if (startCommand != "npm run dev")
            {
                Report(startCommand == "npm run dev:web"
                    ? "API já está saudável. Recuperando apenas o painel, sem alterar banco ou dependências."
                    : "Painel já está saudável. Recuperando apenas a API, sem alterar banco ou dependências.");
                await StartServerAndWaitAsync(repository, startCommand);
                return;
            }

            SetProgress(20, "Verificando Git, Node.js e arquivos locais...");
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
                SetProgress(35, "Consultando atualizações no GitHub...");
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
                            SetProgress(47, "Aplicando atualização segura do GitHub...");
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

            SetProgress(55, "Verificando dependências do projeto...");
            if (updated || !Directory.Exists(Path.Combine(repository, "node_modules")))
            {
                SetProgress(60, "Instalando dependências (npm ci)...");
                Report("A instalação de dependências pode levar alguns minutos. Aguarde.");
                Report("Executando npm ci sem modificar banco, fotos ou .env...");
                var install = await NpmAsync(repository, "npm ci --no-audit --no-fund");
                if (!install.Ok)
                    throw new InvalidOperationException("npm ci falhou: " + Tail(install.Summary));
                Report("Dependências instaladas.");
            }

            SetProgress(76, "Verificando extensão do Brave...");
            if (updated || !File.Exists(Path.Combine(repository, "dist", "extension", "manifest.json")))
            {
                SetProgress(79, "Preparando extensão do Brave...");
                var extension = await NpmAsync(repository, "npm run build:extension");
                if (!extension.Ok)
                    throw new InvalidOperationException(
                        "Compilação da extensão falhou: " + Tail(extension.Summary));
                Report("Extensão atualizada. Recarregue-a em brave://extensions se já estava instalada.");
            }

            await StartServerAndWaitAsync(repository, "npm run dev");
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception error)
        {
            _elapsedTimer.Stop();
            _startupWatch.Stop();
            Status("Não foi possível iniciar o AutoFlow");
            _progressCaption.Text = $"{_progress.Value}%  ·  Inicialização interrompida";
            Report(error.Message);
        }
    }

    private async Task StartServerAndWaitAsync(string repository, string startupCommand)
    {
        SetProgress(87, startupCommand == "npm run dev"
            ? "Iniciando API e painel..."
            : startupCommand == "npm run dev:web"
                ? "Recuperando painel..."
                : "Recuperando API...");
        _server = new Process
        {
            StartInfo = new ProcessStartInfo("cmd.exe")
            {
                Arguments = "/d /c " + startupCommand,
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
        _server.Exited += (_, _) =>
        {
            if (!_updating) Status("A execução do AutoFlow foi encerrada.");
        };
        if (!_server.Start()) throw new InvalidOperationException("npm run dev não iniciou.");
        _serverOwned = true;
        _server.BeginOutputReadLine();
        _server.BeginErrorReadLine();

        SetProgress(93, "Aguardando API e painel ficarem prontos...");
        Report("A primeira otimização das dependências pelo Vite pode demorar.");
        // Do not use a single IPv4-only TCP probe: Vite often listens
        // on IPv6 localhost (::1) on Windows. Require real HTTP responses.
        // A 5-minute deadline gives first-run dependency optimization time.
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < TimeSpan.FromMinutes(5))
        {
            _lifetime.Token.ThrowIfCancellationRequested();
            if (_server.HasExited)
                throw new InvalidOperationException(
                    "O servidor encerrou durante a inicialização. Consulte o registro abaixo.");
            var apiReady = await HttpReadyAsync("http://127.0.0.1:3333/health/ready");
            var panelReady = await PanelReadyAsync();
            var browserApiReady = apiReady && panelReady && await BrowserApiReadyAsync();
            if (apiReady && panelReady && browserApiReady)
            {
                FinishStartup();
                Report("Iniciado com sucesso. Mantenha esta janela aberta.");
                _open.Enabled = true;
                _update.Enabled = true;
                OpenPanel();
                return;
            }
            await Task.Delay(750, _lifetime.Token);
        }
        throw new TimeoutException(
            "O AutoFlow não respondeu nas verificações HTTP após 5 minutos. " +
            "Verifique se o painel abre em http://localhost:5173 e se a API responde " +
            "em http://127.0.0.1:3333/health/ready. Confira o log para detalhes.");
    }

    private async Task UpdateAndRestartAsync()
    {
        if (_updating) return;
        var repository = FindRepository();
        if (repository is null)
        {
            Report("Não encontrei a pasta de instalação para atualizar.");
            return;
        }
        _updating = true;
        _update.Enabled = false;
        try
        {
            Status("Identificando processos do AutoFlow...");
            Report("Verificando os responsáveis pelas portas antes de encerrar qualquer processo.");
            var inspection = await AutoFlowProcessManager.InspectAsync(repository);
            if (!inspection.Safe)
            {
                Report(inspection.Reason);
                Status("Atualização pausada: processo não identificado");
                MessageBox.Show(this,
                    inspection.Reason + "\n\nNenhum processo foi encerrado. " +
                    "Confira o processo ou envie o log para diagnóstico.",
                    "AutoFlow | Proteção de processos", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (inspection.HasListeners)
            {
                var ports = string.Join(", ", inspection.Servers.Select(item => item.Port).Distinct());
                var confirmation = MessageBox.Show(this,
                    $"Os serviços AutoFlow nas portas {ports} serão encerrados para atualizar e reiniciar.\n\n" +
                    "A operação pode interromper um anúncio sendo preenchido ou publicado. " +
                    "Confirme que não há publicação em andamento.\n\n" +
                    "Banco, fotos e configurações serão preservados. Deseja continuar?",
                    "AutoFlow | Atualizar e reiniciar",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                if (confirmation != DialogResult.Yes)
                {
                    Report("Atualização cancelada. Processos mantidos.");
                    return;
                }
                SetProgress(Math.Max(_progress.Value, 14), "Encerrando instâncias verificadas...");
                var stopped = await AutoFlowProcessManager.StopVerifiedAsync(repository, inspection);
                if (!stopped.Success)
                {
                    Report(stopped.Message);
                    Status("Não foi possível encerrar com segurança");
                    return;
                }
                Report("Instâncias AutoFlow identificadas foram encerradas.");
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
                _serverOwned = false;
            }
            _open.Enabled = false;
            _progress.Value = 0;
            _progressCaption.Text = "0%  ·  Preparando atualização";
            _startupWatch.Restart();
            _elapsedTimer.Start();
            Report("Verificando GitHub e reiniciando o AutoFlow...");
            await InitializeAsync();
        }
        catch (Exception error)
        {
            Status("Falha ao atualizar o AutoFlow");
            Report(error.Message);
        }
        finally
        {
            _updating = false;
            _update.Enabled = true;
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
