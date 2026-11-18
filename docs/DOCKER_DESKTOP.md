# Auto Flow sempre ativo no Docker Desktop (Windows 11)

Este projeto já inclui um `Dockerfile`. O `compose.yaml` inicia **um** serviço,
que entrega painel compilado, API e agendamentos em `http://localhost:3333`.
Não precisa de Postgres nem de outro container para os dados: a aplicação
continua usando SQLite.

## Antes de começar

- Docker Desktop instalado, em execução e com WSL2 funcional.
- Diretório local: `C:\Users\Daniel\autoflow-vehicle-poster` (ajuste se for outro).
- Pare qualquer execução anterior com `npm run dev`, `npm run dev:api`
  ou pelo inicializador AutoFlow.exe. **Não execute duas instâncias no mesmo banco**.
- Não troque o valor de `AUTH_SECRET` de uma instalação já usada: ele protege
  sessões e pode estar ligado à recuperação de credenciais.
- Não envie o conteúdo do `.env` para GitHub, issues, chats ou logs compartilhados.

## 1. Preparar a configuração

No PowerShell:

```powershell
cd "C:\Users\Daniel\autoflow-vehicle-poster"
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
