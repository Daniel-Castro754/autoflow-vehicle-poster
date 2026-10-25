# Ponte Activepieces Cloud ou local → Auto Flow → extensão Brave (primeira etapa)

Esta integração reutiliza a **Integration API v1** do Auto Flow. A comunicação
é exclusivamente de saída do Windows para o Activepieces Cloud ou loopback local.
Não crie túnel público para 127.0.0.1, não exponha o banco SQLite e **não compartilhe tokens
de sessão da extensão ou cookies do Facebook**.

## Fluxo do Activepieces

[Auto Flow 2.0 | Ponte local de rascunhos](https://cloud.activepieces.com/projects/PYxTaQE3uELGs9KsZSeeA/flows/HUkFdUKsbbMdvuwXr9UCu)

- Webhook autenticado por cabeçalho, **rascunho não publicado**.
- Consulta a tabela `fila_publicacoes` (somente estados `pendente` e `pronto_para_executar`) e
  a tabela `vehicles` (veículos `ativo` e `valido`).
- Resposta JSON contém candidatos à criação de **rascunhos locais**, nunca
  comandos para clicar em Publicar, iniciar sessão ou contornar desafios.
- A fila de teste estava vazia durante a implementação. Teste com dados fictícios
  foi aprovado com zero transferências. Adicionar itens exige validação independente.

## Preparação obrigatória

1. Abra o fluxo, configure o gatilho com **Header Auth** e troque a chave
   de exemplo por um segredo aleatório de no mínimo 24 caracteres.
   Em PowerShell, crie uma chave de 32 bytes e guarde-a em lugar seguro:
   ```powershell
   $bytes = [byte[]]::new(32)
   $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
   try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
   $env:ACTIVEPIECES_BRIDGE_KEY = [Convert]::ToBase64String($bytes)
   ```
   Cole esse mesmo valor no campo Header Value do fluxo, sem expô-lo em chat.
2. Publique e ative somente o fluxo de ponte **após** configurar a chave.
   Copie a URL de webhook, acrescente `/sync` ao final e confira
   que termina em `/api/v1/webhooks/.../sync` e começa com HTTPS.
3. No Windows, deixe o Auto Flow e a API local abertos; use PowerShell:
   ```powershell
   cd "$HOME\autoflow-vehicle-poster"
   $env:ACTIVEPIECES_BRIDGE_URL = "https://cloud.activepieces.com/api/v1/webhooks/SEU_ID/sync"
   # A variável ACTIVEPIECES_BRIDGE_KEY deve conter a mesma chave do gatilho.
   node scripts/activepieces-bridge.mjs
   ```
   Por padrão o comando só imprime uma prévia. Não cria veículos, filas ou anúncios.
4. Para testar o mapeamento sem conectar contas:
   ```powershell
   node scripts/activepieces-bridge.mjs --fixture tests/fixtures/activepieces-bridge.json
   ```
5. Verifique o relatório `missingOrInvalid`. As Tables atuais não possuem
   carroceria, estado de conservação e cor interna. Forneça essas informações
   **por veículo**, sem inventar fatos, em um JSON local (fora do Git):
   ```json
   {
     "PILOTO-001": {
       "vehicleType": "Carro/picape",
       "bodyType": "Sedã",
       "condition": "Bom",
       "interiorColor": "Preto"
     }
   }
   ```
   Teste novamente com `--overrides caminho-do-arquivo.json`.
6. **Somente quando desejar criar rascunhos reais:** no painel do Auto Flow,
   gere uma credencial da Integration API com **apenas** o escopo
   `vehicles:create` e vencimento curto. O token `afi_...` é exibido uma única vez.
   Configure `$env:AUTOFLOW_INTEGRATION_TOKEN` no PowerShell (nunca no Git)
   e execute:
   ```powershell
   node scripts/activepieces-bridge.mjs --overrides .\meus-ajustes.json --create-drafts --confirm-drafts
   ```
   A API cria exclusivamente veículos `Rascunho`, limitados à organização
   da credencial. Se o código de estoque ou VIN já estiver cadastrado,
   o resultado `409` é tratado como conflito, sem criar duplicata.

## Etapa seguinte: validação no Brave

1. Confira cada rascunho na interface Auto Flow e importe **fotos reais**
   manualmente pelo fluxo existente, associando pelo código de estoque.
2. Confirme conta e autorização, descrição, preço e imagens.
3. Abra a fila somente depois da revisão; realize um teste **assistido**
   de preenchimento no Facebook Marketplace, **sem clicar em Publicar**.
4. Verifique o relatório de campos preenchidos e o estado da execução.

**Limitações:** a ponte não baixa imagens de URLs remotas; não gera
credenciais Facebook, não cria jobs de publicação, não aciona a extensão
automaticamente e não confirma que formulários do Facebook foram preenchidos.
O primeiro objetivo é transporte seguro de rascunhos e inspeção local.

Para testes automatizados:

```powershell
npm run test:bridge
```

## Instalação local no Windows (sem créditos do Cloud)

Para experimentos individuais use a [instalação Docker oficial](https://www.activepieces.com/docs/install/options/docker)
com PGLite e Redis em memória. Requer Docker Desktop ligado.

```powershell
docker volume create activepieces_local_data
docker run -d --name activepieces-local --restart unless-stopped `
  -p 127.0.0.1:8080:80 `
  -v activepieces_local_data:/root/.activepieces `
  -e AP_DB_TYPE=PGLITE `
  -e AP_REDIS_TYPE=MEMORY `
  -e AP_FRONTEND_URL=http://localhost:8080 `
  activepieces/activepieces:latest
docker ps --filter "name=activepieces-local"
Invoke-RestMethod http://localhost:8080/api/v1/health
```

Abra http://localhost:8080 para criar o usuário administrador. O volume nomeado
preserva os dados entre reinicializações do contêiner. **Não execute novamente**
o comando docker run com o mesmo nome; para iniciar use
`docker start activepieces-local`.

A instalação local é **independente** da conta cloud.activepieces.com. Ela
não recebe automaticamente os fluxos, tabelas, histórico ou conexões.
Exportar o JSON do fluxo pela interface do Cloud e importar no local
pode exigir recriar as Tables e remapear seus identificadores e credenciais.
Não publique o fluxo de ponte enquanto a autenticação estiver com a chave
de exemplo.

Depois de importar/recriar e publicar a ponte na instalação local, copie
a **nova URL gerada pelo Webhook local**, que não usa o ID do fluxo Cloud.
A URL esperada terá formato:

```powershell
$env:ACTIVEPIECES_BRIDGE_URL = "http://localhost:8080/api/v1/webhooks/SEU_WEBHOOK_LOCAL/sync"
# ACTIVEPIECES_BRIDGE_KEY deve conter a mesma chave Header Auth do fluxo local
node scripts/activepieces-bridge.mjs
```

O comando não envia comandos à extensão Brave ou ao Facebook e não cria
rascunhos sem `--create-drafts --confirm-drafts`.
O transporte HTTP é aceito **somente para localhost/127.0.0.1 na porta 8080**;
Cloud continua exigindo HTTPS.
