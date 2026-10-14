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

1. Localiza o repositório e verifica se as portas 3333 ou 5173 já estão em uso.
2. Confirma Git e Node.js >=22.18.0.
3. Se estiver na `main` com arquivos rastreados limpos, faz `git fetch origin main`.
4. Atualiza **somente por fast-forward**, sem `git reset`, `git clean` ou `git stash`.
5. Se houver atualização ou `node_modules` estiver faltando, executa `npm ci`.
6. Se o código da extensão mudou, executa `npm run build:extension`.
7. Executa `npm run dev` e abre `http://localhost:5173` quando API e painel responderem.

Se o GitHub estiver inacessível, mantém o código local e tenta iniciar. Se houver alterações
locais, ou a branch atual não for `main`, **não atualiza**. Caso o AutoFlow já esteja
rodando, não mexe em arquivos nem inicia uma segunda instância.

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
