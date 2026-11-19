# Auto Flow sempre ativo no Docker Desktop (Windows 11)

Este projeto já inclui um `Dockerfile`. O `compose.yaml` inicia **um** serviço,
que entrega painel compilado, API e agendamentos em `http://localhost:3333`.
Não precisa de Postgres nem de outro container para os dados: a aplicação
continua usando SQLite.

## Antes de começar

- Docker Desktop instalado, em execução e com WSL2 funcional.
- Diretório local: `$HOME\autoflow-vehicle-poster` (ajuste se for outro).
- Pare qualquer execução anterior com `npm run dev`, `npm run dev:api`
  ou pelo inicializador AutoFlow.exe. **Não execute duas instâncias no mesmo banco**.
- Não troque o valor de `AUTH_SECRET` de uma instalação já usada: ele protege
  sessões e pode estar ligado à recuperação de credenciais.
- Não envie o conteúdo do `.env` para GitHub, issues, chats ou logs compartilhados.

## 1. Preparar a configuração

No PowerShell:

```powershell
cd "$HOME\autoflow-vehicle-poster"
git switch main
git pull --ff-only
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

Configure no `.env`:

- `AUTH_SECRET`: mínimo 32 caracteres aleatórios; **reutilize o atual** se já
  houver contas, cofre ou dados.
- `INITIAL_ADMIN_EMAIL` e `INITIAL_ADMIN_PASSWORD` (mínimo 12 caracteres)
  somente para criar o administrador de um banco vazio.
- `GOOGLE_CLIENT_ID` se quiser o login Google.
- `PUBLIC_ORIGIN=http://localhost:3333` para usar o painel no endereço padrão.
- `SCHEDULE_TIMEZONE=America/Sao_Paulo`.

Para gerar um novo segredo **somente em uma instalação nova**:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

O Compose força `HOST=0.0.0.0` **dentro do container** e publica a porta apenas
em `127.0.0.1` **no Windows**. Assim a interface não é exposta à rede local.
Não altere `HOST` ou `DATA_DIR` para contornar problemas de acesso.

## 2. Proteger dados que já existem

O arquivo `compose.yaml` usa a montagem `./data:/app/data`; portanto,
reaproveita `data/autoflow.db`, `data/uploads` e os demais arquivos do cofre
no mesmo diretório do projeto. Não existe migração automática para um volume
vazio e não se deve apagar `data`.

Se o banco `data/autoflow.db` já existir, **com o Auto Flow parado**,
faça um backup consistente antes do primeiro deploy:

```powershell
if (Test-Path .\data\autoflow.db) {
    New-Item -ItemType Directory -Force .\backups | Out-Null
    npm run backup -- create .\backups
}
```

Guarde também uma cópia do backup em outro disco. Nunca copie um SQLite ativo
como se fosse um backup consistente. O backup do projeto inclui o banco,
as imagens e os arquivos necessários do cofre.

## 3. Subir uma vez; continuar automaticamente

```powershell
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://localhost:3333/api/health/ready
```

O resultado esperado da última chamada é `status: ready`. Depois abra
**http://localhost:3333**. No Docker Desktop, a stack aparecerá como
`autoflow-vehicle-poster`.

`restart: unless-stopped` reinicia o container após falha ou reinício do
serviço Docker, exceto quando ele foi interrompido manualmente. Para o
Docker Desktop iniciar com o Windows, habilite **Settings → General →
Start Docker Desktop when you sign in**.

**Limite:** isso não mantém nada rodando com o PC desligado, em suspensão,
ou antes de o Docker Desktop iniciar após o login do Windows.

## Operação diária

```powershell
docker compose ps
docker compose logs --tail=100 app
docker compose restart app
docker compose stop app
docker compose start app
```

Quando você atualizar o código:

```powershell
git pull --ff-only
docker compose up -d --build
```

Se houver alterações locais em arquivos versionados, resolva-as antes do
`git pull`; **não use `git reset --hard` para forçar atualizações**.

Para backup futuro, primeiro pare o serviço, crie e verifique a cópia
e depois volte a iniciar:

```powershell
docker compose stop app
npm run backup -- create .\backups
docker compose start app
```

Para validar um backup específico:

```powershell
npm run backup -- verify ".\backups\autoflow-backup-AAAA-MM-DD..."
```

Substitua o nome de exemplo pela pasta realmente criada.

## Backup automático e troca segura da chave (Docker Desktop)

O script `scripts/backup-docker.ps1` executa o backup **sem instalar npm no host**.
Ele interrompe somente o serviço `app`, usa a imagem Docker já criada,
verifica o backup com o mecanismo oficial do projeto e reinicia o app no
bloco `finally` se estava rodando anteriormente:

```powershell
cd "$HOME\autoflow-vehicle-poster"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-docker.ps1
docker compose ps
```

O destino padrão é `backups/`. O script nunca exclui backups antigos;
acompanhe o espaço ocupado e **guarde outra cópia fora do computador**.
A verificação de hash/SQLite não substitui um ensaio de restauração.

Para configurar backup diário **às 03:00**, somente quando a sessão Windows
estiver aberta e o Docker Desktop funcionando:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-backup-task.ps1 -At 03:00
Get-ScheduledTask -TaskName "AutoFlow - Backup Diario"
```

O agendamento é opcional e só é criado após executar o instalador.
O script não agenda publicações no Marketplace. A cópia para e reinicia o
Auto Flow por um curto período; escolha um horário sem trabalho na fila.
O Docker Desktop não executa uma tarefa com o computador desligado.

### AUTH_SECRET exposto: rotação offline para banco sem credenciais criptografadas

**Não copie o segredo em chats ou comandos.** O `AUTH_SECRET` atual foi usado
para criar o cofre Linux, portanto uma troca cega pode inutilizar credenciais.
O script de rotação verifica a tabela de segredos e **recusa executar** se
encontrar chaves criptografadas. Não apaga `vault-key.json`.

```powershell
cd "$HOME\autoflow-vehicle-poster"
node scripts/rotate-auth-secret.mjs --check
# Se a checagem permitir, crie um backup antes de continuar:
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-docker.ps1
docker compose stop app
node scripts/rotate-auth-secret.mjs --apply
docker compose up -d --force-recreate app
docker compose ps
Invoke-RestMethod http://localhost:3333/api/health/ready
```

O comando `--apply` exige backup **válido das últimas 24 horas** na pasta
`backups/`, gera uma nova chave criptograficamente segura e altera apenas
`AUTH_SECRET` no arquivo `.env`. **A nova chave não é exibida no terminal**.
As sessões antigas deixam de funcionar: entre novamente no painel e renove
a autenticação da extensão, se usada.

**Se a checagem recusar por haver credenciais criptografadas, não tente
contornar apagando o cofre.** A instalação exige uma migração criptográfica
específica antes da rotação; preserve a chave e o backup atuais até realizar
esse procedimento.

Depois do primeiro login bem-sucedido, você pode deixar
`INITIAL_ADMIN_PASSWORD=` vazio no `.env`: esse campo só é necessário se
o banco **não tiver usuários**. Mantenha uma cópia protegida da chave atual
em um gerenciador de senhas, fora do GitHub.

## Atenção: Google, Brave e Activepieces

- **Google:** autorize `http://localhost:3333` como origem JavaScript na
  configuração OAuth. A primeira vinculação ainda exige a senha do Auto Flow.
- **Extensão Brave:** continua acessando a API em `127.0.0.1:3333` no Windows.
  O Docker mantém a API viva, **não inicia nem mantém o Brave aberto** e não
  torna o Facebook Marketplace independente da extensão/navegador.
- **Activepieces:** a ponte atual em `scripts/activepieces-bridge.mjs` é um
  comando separado. Subir o container não a torna automaticamente recorrente;
  consulte `docs/ACTIVEPIECES_BRIDGE.md`.

### Solução de problemas

- `AUTH_SECRET deve ter pelo menos 32 caracteres`: complete `.env` com o
  segredo correto; para dados existentes não gere outro.
- `port is already allocated`: encerre a execução antiga da API/launcher
  que ocupa a porta 3333. A extensão também pressupõe essa porta.
- `permission denied` em `/app/data`: confira permissões/compartilhamento
  de arquivos do Docker Desktop; não execute duas instâncias no mesmo SQLite.
- Login Google falha: confira o `GOOGLE_CLIENT_ID`, a origem
  `http://localhost:3333` e os logs do container.
- `unhealthy`: verifique `docker compose logs --tail=100 app`; a
  verificação de integridade consulta `/api/health/ready`. O Docker não
  reinicia um processo apenas porque o healthcheck ficou unhealthy.
