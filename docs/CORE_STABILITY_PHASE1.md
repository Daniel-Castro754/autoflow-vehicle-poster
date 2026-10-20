# Estabilidade do núcleo — Fase 1 (primeira entrega)

## Escopo implementado

1. **Exclusão mútua do launcher por sessão Windows.** Um mutex nomeado
   (`Local\AutoFlow.Launcher`) evita que duas janelas concorrentes executem
   atualização Git, npm ci ou inicialização de API e painel ao mesmo tempo.
   O processo atual mantém a trava enquanto sua janela estiver aberta.
   O Windows recupera a trava após o encerramento do processo.
2. **Rotação do diagnóstico local.** `%LOCALAPPDATA%\AutoFlow\launcher.log`
   é rotacionado para `launcher.log.1` quando ultrapassar 2 MiB com a próxima
   linha; linhas anormalmente grandes são truncadas. O diagnóstico continua fora
   do repositório, sem alteração do banco, credenciais ou fotos.
3. **Teste regressivo Windows** da trava entre threads e da rotação de logs,
   além dos testes já existentes de readiness HTTP e proteção de processos.

## Validação automatizada

```powershell
dotnet run --project launcher-smoke/AutoFlow.Launcher.Smoke.csproj -c Release
dotnet publish launcher/AutoFlow.Launcher.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o launcher-output
```

O workflow `.github/workflows/windows-launcher.yml` executa esses passos
em Windows após a abertura do PR.

## Fora desta primeira entrega

- **Rollback transacional de atualizações:** após fast-forward, uma falha em
  `npm ci` ou no build da extensão ainda exige diagnóstico manual.
  Não foi adicionado reset automático porque existem migrações de banco e
  instalações com possíveis mudanças locais que precisam de estratégia segura.
- **Supervisão de subprocessos após falha, reinício do backend e recuperação
  de instâncias órfãs:** exigem testes reais no Windows e deverão ser tratados
  em mudanças isoladas.
- **Instalação sem Node/Git ou substituição automática do próprio EXE:**
  continuam fora do escopo. O launcher distribuído precisa ser baixado do
  workflow Windows launcher EXE.

A alteração é deliberadamente conservadora: não muda regras de anúncios,
publicações, autenticação, filas, banco ou atualização existente.
