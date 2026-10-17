# AutoFlow.exe — inicializador para Windows

O launcher é um **executável Windows x64 independente** (sem necessidade de instalar .NET).
Foi feito para a instalação já existente em:

```text
C:\Users\Daniel\autoflow-vehicle-poster
```

De maneira geral ele procura `%USERPROFILE%\autoflow-vehicle-poster`. O caminho pode ser
alterado com a variável de ambiente `AUTOFLOW_REPO_PATH` antes de abrir o executável.

## Baixar o executável

1. Abra **GitHub → Actions → Windows launcher EXE** no repositório.
2. Escolha a execução bem-sucedida da branch **main**.
3. Na seção **Artifacts**, baixe `AutoFlow-Windows-x64`.
4. Extraia `AutoFlow.exe` para sua Área de Trabalho e dê duplo clique.

A compilação automática é publicada como artefato pela CI a cada atualização do código do
launcher (o link do artefato é temporário, não uma instalação permanente).

## O que acontece ao iniciar

1. Localiza o repositório e verifica se as portas 3333 ou 5173 já estão em uso (IPv4 e IPv6).
2. Confirma Git e Node.js >=22.18.0.
3. Se estiver na `main` com arquivos rastreados limpos, faz `git fetch origin main`.
4. Atualiza **somente por fast-forward**, sem `git reset`, `git clean` ou `git stash`.
5. Se houver atualização ou `node_modules` estiver faltando, executa `npm ci`.
6. Se o código da extensão mudou, executa `npm run build:extension`.
7. Executa `npm run dev`, espera a API responder em `http://127.0.0.1:3333/health/ready`
   e o painel em `http://localhost:5173` (com suporte a localhost IPv6/IPv4).
   O primeiro carregamento pode levar até cinco minutos devido à otimização de dependências.

A interface mostra **barra de progresso por etapas**, percentuais, tempo decorrido e,
a partir de uma execução concluída, a **média real de inicialização medida no próprio PC**.
Antes de haver histórico, exibe uma estimativa geral de 1–4 minutos; a primeira
instalação pode ser mais lenta. O histórico, sem senhas nem dados do negócio,
fica em `%LOCALAPPDATA%\AutoFlow\startup-times.json`. Os percentuais são por
etapa concluída, não uma previsão exata do tempo restante.

Se aparecer `A task was canceled` em uma versão antiga mesmo com o Vite e
API abertos, substitua o EXE pelo artefato desta correção: a versão anterior
checa apenas IPv4 e tinha um limite de 90 segundos que podia encerrar a
verificação em máquinas cujo Vite escutasse no endereço IPv6 `::1`.
O novo launcher usa **respostas HTTP reais**, prazo maior e erros explicativos.

Se o GitHub estiver inacessível, mantém o código local e tenta iniciar. Se houver alterações
locais, ou a branch atual não for `main`, **não atualiza**. Caso a API e o painel já estejam
rodando e saudáveis, não mexe em arquivos nem inicia uma segunda instância.
Quando só a API estiver saudável, inicia apenas `npm run dev:web`; quando
só o painel estiver saudável, inicia apenas `npm run dev:api`. Nesses
casos, pula a atualização dos arquivos para não modificar o código de uma
instância ativa.

Se a porta 3333 ou 5173 estiver ocupada mas não responder como AutoFlow,
o launcher **não encerra processos às cegas**: ele informa qual serviço
falhou e mostra comandos para identificar o processo. Se necessário, abra
PowerShell e execute:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3333,5173 -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess
```

Confira o PID com `Get-CimInstance Win32_Process -Filter "ProcessId=PID"`
e feche **somente** o processo que você confirmou pertencer a uma
instância antiga do AutoFlow.

Na janela, confira `Inicializador v1.2` e a barra de progresso. Se
eles não aparecerem, o atalho ainda aponta para o `AutoFlow.exe` antigo:
extraia novamente o executável mais recente do ZIP e substitua o anterior.

O banco SQLite, as fotos, os backups, `.env` e as credenciais locais **não são apagados
nem substituídos pelo inicializador**. Atualizações normais do backend ainda podem aplicar
migrações de banco versionadas, conforme as regras do próprio projeto.

**Mantenha a janela do launcher aberta** enquanto utilizar o programa. O botão
**Encerrar AutoFlow** termina os servidores iniciados por esta janela. Um servidor
já existente e detectado pelo launcher nunca será encerrado por ele.

Após atualização da extensão, entre em `brave://extensions` e clique em **Recarregar**
na extensão AutoFlow. Navegadores não recarregam automaticamente extensões
descompactadas simplesmente porque os arquivos foram atualizados.

## Pré-requisitos e solução de problemas

- Windows 10/11 64 bits.
- Repositório já clonado com Git e `node_modules` pode ser instalado pela primeira execução.
- Git, Node.js >=22.18.0 e npm disponíveis no PATH.
- Arquivo `.env` configurado com o `AUTH_SECRET` existente e as demais credenciais;
  o launcher **não cria nem redefine segredos**.
- Rede disponível para baixar novas versões. Sem rede, usa a cópia local.
- Para diagnosticar uma falha, consulte a janela do launcher e
  `%LOCALAPPDATA%\AutoFlow\launcher.log`.

Para desenvolver ou validar a compilação do launcher:

```powershell
dotnet publish launcher/AutoFlow.Launcher.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=false -p:IncludeNativeLibrariesForSelfExtract=true -o launcher-output
```
