# Etapa 4.1 — Auditoria e contrato de sincronização de estoque

Base auditada: `dbb6e70`. Esta etapa documenta o contrato da futura sincronização; não ativa leitura do Google, não altera o estoque e não cria publicações.

## Inventário técnico

| Componente | Estado observado | Consequência |
|---|---|---|
| Login Google | `server/services/google-sign-in.ts` e `docs/GOOGLE_SIGN_IN.md` descrevem autenticação de identidade, sem acesso a Drive/Sheets | Não reutilizar o token de identidade como autorização de dados |
| CSV/ZIP/pasta | `server/routes/vehicles.ts`, `docs/VEHICLE_ZIP_IMPORT.md` e `docs/FOLDER_STOCK_IMPORT.md`: importação supervisionada, prévia, validação, proteção de estoque ativo | Reutilizar normalização e validação; não remover a prévia de importações manuais |
| Activepieces | `scripts/activepieces-bridge.mjs` e `scripts/activepieces-bridge-lib.mjs`: prévia de candidatos em modo draft_only, criação explícita de rascunhos, envelope não truncado de até 50 trabalhos | A ponte não representa inventário completo nem confirmação de venda; não habilitar execução periódica por padrão |
| API de integração | `server/routes/integration.ts`: GET de veículos limitado a 250 registros; POST cria Rascunho, retorna 409 em identificador existente; sem rota de atualização nessa interface | Não usar o GET atual como inventário completo; resolver paginação e identidade antes de reconciliar |
| Fotos | `server/routes/integration-photos.ts`: escopo photos:write, somente rascunhos, validação de imagem, SHA-256 e limite de 20 fotos | Revalidar estado e autorização após operações assíncronas; serializar checagem de duplicidade e limite antes de automatizar |
| Venda | `server/routes/vehicles.ts`: operação explícita mark-sold, tratamento de trabalhos existentes | Não inferir venda por ausência de linha, pasta ou foto |
| Agendamento | Motor recorrente independente do importador, com validações e proteções próprias | A sincronização não deve criar anúncios diretamente nem contornar os critérios de elegibilidade |

A auditoria é do código e documentação do repositório; não comprova configuração, permissões ou conteúdo dos recursos Google e Activepieces reais.

## Contrato proposto

- Sheets: fonte proposta de dados cadastrais e de situação comercial; Drive: fonte proposta de arquivos por identificador estável de estoque. Confirmar layout e propriedade dos recursos antes de ativar. Não associar veículos por semelhança de marca, modelo ou nome de pasta.
- Identidade: código de estoque normalizado e único dentro da organização; VIN quando disponível, sem sobrescrever identidades conflitantes. IDs externos de arquivos/pastas são referências, não substitutos do código de estoque.
- Fonte: configurar por organização e usar acesso restrito de leitura aos recursos necessários. Não usar senha Google ou token de identidade; não registrar credenciais, URLs assinadas ou dados brutos em logs.
- Leitura: diferenciar leitura completa, incompleta, vazia, truncada, sem autorização e falha transitória. Verificar paginação antes de considerar uma rodada completa. Nenhum dado ausente é evidência de venda.
- Planejamento: calcular novos, alterações, inalterados, conflitos e ausentes sem gravar. Identificadores duplicados ou conflitantes devem ser encaminhados à revisão; falha da fonte não altera o estoque.
- Aplicação: opt-in explícito, escopo da organização, idempotência, revalidação da revisão e das proteções de publicação no momento de aplicar. Novos veículos entram como Rascunho. Não alterar veículos vendidos, publicados ou com execução ativa sem tratamento autorizado.
- Fotos: vínculo exato por código, validação de conteúdo, deduplicação e limites existentes; não apagar nem trocar galeria com base na ausência de arquivo.
- Venda: tratar somente sinal explícito e verificável na fonte, por meio das regras existentes de venda e conciliação; não cancelar, apagar ou remover anúncio no Facebook por inferência.
- Auditoria: registrar rodada, fonte, horário, resultado e contagens de cada classe; sem segredos. Falhas devem ser observáveis e não podem impedir o motor de publicação independente.
- Produção: iniciar com prévias somente leitura e testes offline; nenhuma sincronização automática em produção antes da homologação e autorização da fonte.

## Sequência de implementação

1. Auditoria e contrato (este documento).
2. Modelo de leitura e planejamento de sincronização, tratamento de falhas, idempotência e fonte configurável.
3. Identificação de novos veículos e associação segura de fotos.
4. Validação cadastral e revisão de alterações.
5. Tratamento de venda explícita e divergências, sem remoção inferida.
6. Integração com o piloto automático, observabilidade e testes de implantação.

## Verificações existentes

`npm run test:google-auth`, `npm run test:bridge`, `npm run test:integration-credentials`, `npm run test:vehicle-import`, `npm run test:vehicle-zip`, `npm run test:folder-import`, `npm run test:stock`, `npm run test:publish-safety`.

Esses testes não comprovam uma sincronização real com Google Drive/Sheets. A configuração das fontes, a autorização e uma rodada somente leitura devem ser verificadas separadamente.

## Etapa 4.2 — Prévia da sincronização

A API aceita `POST /api/integration/v1/stock/preview` com credencial de integração com escopo `vehicles:read`. O endpoint não consulta Google diretamente, não cadastra veículos, não altera fotos e não agenda publicações. A identificação da organização vem da credencial, nunca do corpo.

Exemplo de envelope normalizado (dados fictícios):

```json
{
  "version": 1,
  "source": "sheets",
  "sourceState": "complete",
  "rows": [
    {
      "stockCode": "SAVEIRO-19",
      "year": 2019,
      "make": "Volkswagen",
      "model": "Saveiro",
      "price": 60900,
      "km": 80000
    }
  ]
}
```

- Fontes declaradas: `sheets`, `activepieces`, `manual`. Estados: `complete`, `partial`, `failed` (este último exige lista vazia). A origem e a completude são declarações do remetente, ainda não verificadas pelo servidor.
- Até 500 linhas por envelope e 1 MiB por requisição; até 10.000 registros locais na comparação. Campos básicos obrigatórios, números JSON reais; VIN e versão opcionais. Fabricante deve pertencer ao catálogo existente. Não há alterações de status nem campos livres nesta prévia.
- `counts` e `entries` distinguem `new`, `changed`, `unchanged` e `conflict`. As diferenças retornam nomes de campos; VIN incompatível, identidades repetidas e alterações em veículos protegidos exigem revisão.
- `absence` é informativa, nunca ação de venda. A comparação de ausência é suprimida em fontes parciais, com falha, vazias ou com conflitos detectados. Mesmo em leitura declarada completa, veículos não vistos não devem ser marcados como vendidos.
- A consulta registra metadados de auditoria e uso de credencial, sem alterar estoque, fotos ou fila. Não é um plano de aplicação autorizado; nenhuma operação de gravação pode consumir esse resultado como autorização.
- A conversão de planilhas e pastas reais, a leitura recorrente, validação completa de cadastro e o mecanismo opt-in de aplicação ainda serão implementados.

## Etapa 4.3 — Conciliação de fotos

O envelope de prévia aceita opcionalmente `photos`, uma lista de até 2.000 registros com `stockCode` e `sha256` (hash hexadecimal de 64 caracteres). Cada código precisa identificar exatamente uma linha sem conflito na lista de veículos. O manifesto não aceita URLs, caminhos de arquivos ou instruções de download.

A resposta `photoPreview` distingue fotos novas, presentes e conflitos. A mesma foto declarada para veículos diferentes, duplicidades no manifesto, códigos desconhecidos, galerias sem hash verificável, fotos compartilhadas no estoque local e limites de 20 imagens são motivos de revisão. Novas fotos em veículos locais são candidatas somente quando se trata de rascunhos não vendidos e sem trabalhos protegidos. A ausência de fotos no manifesto não exclui nenhuma imagem. A comparação de ausência de veículos continua independente.

Os hashes na prévia são declarados pelo remetente e não comprovam a autenticidade da foto. O upload de conteúdo real continua exigindo `photos:write`, a validação do formato e o SHA-256 calculado pelo servidor. O endpoint existente de upload também aceita `stockCode` e `sha256` opcionais; o futuro conector deve fornecê-los ambos para conferir a associação e o conteúdo. A gravação revalida credencial, estado, duplicidade e limite de galeria dentro de uma transação de escrita após a decodificação assíncrona. Imagens com o mesmo conteúdo em outro veículo da mesma organização são recusadas; o mesmo conteúdo no próprio veículo permanece idempotente. Os arquivos não são substituídos nem removidos por sincronização.

Não há leitura ou download automático do Google Drive nesta etapa. Ainda será necessário definir e autorizar as fontes reais, implementar o conector e homologar o fluxo de aplicação.

## Etapa 4.4 — Validação dos dados cadastrais

A prévia aceita adicionalmente, em cada linha, `vehicleType`, `location`, `transmission`, `fuelType`, `bodyType`, `exteriorColor`, `interiorColor`, `condition` e `description`. Estes campos continuam opcionais no envelope para compatibilidade com a versão anterior. Valores enviados são strings limitadas (200 caracteres, descrição até 4.000); os catálogos são os mesmos utilizados pelo cadastro do AutoFlow. Campos básicos e identidade continuam sujeitos às validações estritas anteriores. Não são aceitos campos de status ou comandos de execução.

A resposta `validation` contém totais de linhas com campos de origem completos ou incompletos, e por linha:

- `missingFields` e `invalidFields`: nomes dos campos ausentes/vazios ou fora do catálogo, sem reproduzir os valores inválidos.
- `sourceFieldsComplete`: completude dos dados declarados na origem, não do cadastro local. Não usa valores anteriores, descrição gerada ou localização padrão para ocultar lacunas.
- `identityConflict`: conflito de conciliação, independente da completude.
- `localPhotoCount`, `declaredNewPhotos`, `photoConflicts`, `requiresPhotoVerification` e `needsPhotos`: evidência de registros locais e manifesto, sem comprovar arquivos reais ou conteúdo externo.

As diferenças também incluem os campos adicionais fornecidos. Um campo inválido ou vazio pode aparecer como diferença, mas a validação deve ser respeitada antes de qualquer futura aplicação. Nenhuma alteração é aplicada por esta rota. A completude de campos não equivale a status Pronto, autorização, ausência de bloqueios ou aptidão para publicar. A futura gravação deverá revalidar identidade, dados, conteúdo e estado atual, usando as regras de cadastro e publicação existentes.

## Etapa 4.5 — Conciliação de situação comercial

A linha pode declarar `commercialState: "available"` ou `commercialState: "sold"`. O campo é opcional e não corresponde ao status operacional do AutoFlow. Outros valores são rejeitados; a integração deverá mapear os valores da fonte real explicitamente.

Uma venda declarada nunca é candidata a criação ou atualização cadastral normal. Sem correspondência local, com identidade ambígua ou com ano, fabricante, modelo ou VIN local não conferidos, exige revisão de identidade. Mesmo uma venda que corresponda ao cadastro local exige revisão humana da origem e do impacto sobre os trabalhos. Uma venda já registrada localmente é identificada sem nova ação; uma declaração de disponibilidade para um veículo vendido exige revisão e não o reabre.

A resposta `commercialReview` lista sinais explícitos, vendas já registradas, divergências, IDs locais quando resolvidos, presença de trabalhos protegidos e necessidade de revisão. `executed` permanece falso. O campo `validation.identityConflict` conserva o comportamento anterior de sinalizar qualquer conflito de conciliação, inclusive os novos motivos comerciais; não significa necessariamente erro de VIN.

Leitura parcial pode apresentar sinais explícitos para revisão, nunca executar uma venda. Fonte vazia, falha de acesso ou ausência de linha não são sinal de venda. Fotos novas para linhas de venda não são candidatas a importação. Nenhuma mudança é feita no estoque ou na fila. Após verificação humana, o fluxo existente de marcar vendido no painel continua sendo o caminho de aplicação, com revisão de execuções e anúncios incertos; não é substituído por esta prévia.

A leitura real do Google, a autorização da fonte, o agendamento e a aplicação automática ainda precisam de implementação e homologação específicas.

## Etapa 4.6 — Leitura Google Sheets e aplicação restrita

O comando `node scripts/stock-sheet.mjs` lê uma aba dedicada do Google Sheets com conta de serviço e escopo `spreadsheets.readonly`, envia o snapshot à API local e exibe contagens da prévia. O login Google do painel continua independente. A leitura usa a API oficial `spreadsheets.values.get`, com valores não formatados; não lê o Drive.

Configuração local (não enviar os segredos ao Git, ao chat ou aos logs):

- Habilitar a API Google Sheets no projeto Google Cloud e compartilhar somente a planilha dedicada com a conta de serviço, como leitora. Armazenar o arquivo JSON da conta de serviço fora do repositório e definir `GOOGLE_APPLICATION_CREDENTIALS` com seu caminho.
- Definir `AUTOFLOW_STOCK_SHEET_ID` com o ID da planilha e `AUTOFLOW_STOCK_SHEET_TAB` com o nome exato da aba. `AUTOFLOW_INTEGRATION_TOKEN` deve ser uma credencial local com `vehicles:read` para prévia. O destino da API é o loopback HTTP (padrão `http://127.0.0.1:3333`).
- Primeira linha da aba: cabeçalhos exatos (ordem livre) `stockCode, year, make, model, price, km, commercialState, vehicleType, location, transmission, fuelType, bodyType, exteriorColor, interiorColor, condition, description`. Opcionais: `vin, trim`. Não usar colunas extras, cabeçalhos duplicados ou linhas de totais. Códigos de estoque e VIN são texto; ano, preço e quilometragem são células numéricas. Situação comercial é `available` ou `sold`, sem inferência de estado. Os valores de catálogo devem seguir o AutoFlow. Não se assume compatibilidade com a planilha real existente.
- A leitura abrange a aba escolhida, com até 500 linhas de dados, resposta Google de até 2 MiB e snapshot de até 1 MiB. Leituras excessivas, estrutura inválida, falhas e credenciais ausentes interrompem a operação. Uma aba dedicada não comprova que todo o estoque real está nela. Não há truncamento silencioso.

Para aplicação, um administrador deve emitir uma credencial específica pela API de credenciais com os três escopos `stock:apply`, `vehicles:read` e `vehicles:create`. O novo escopo não é atribuído automaticamente a credenciais existentes. A configuração do painel para emissão desse escopo não foi alterada nesta etapa.

Somente após homologar a leitura, o operador pode executar `node scripts/stock-sheet.mjs --apply-drafts`. O comando solicita `POST /api/integration/v1/stock/apply-drafts` com corpo `{ "confirm": "create_drafts", "snapshot": { ... } }`. O servidor revalida credencial e snapshot sob transação de escrita. Fontes parciais, vazias, com falha ou conflitos são recusadas; somente veículos novos, explicitamente disponíveis e com dados completos e válidos são criados como Rascunho. Veículos já existentes ou incompletos são ignorados com motivo; não há atualização automática de preços, situação comercial ou fotos. Repetir a mesma fonte não duplica os rascunhos. A ausência de foto não impede criar rascunho, mas impede elegibilidade para publicação.

O agendador atual só poderá considerar esses veículos após revisão, fotos verificadas e promoção autorizada para Pronto pelo fluxo existente. A importação não cria publicações, não reabre vendidos, não altera limites e não aciona o Facebook. Não foi instalado agendamento periódico do leitor, nem conector de Drive, nem configuração real de credenciais. É necessário homologar a planilha, implementar a ingestão de fotos e estabelecer a execução periódica antes de concluir a automação em produção.

Verificações: `npm run test:stock-sheet` (mapeamento offline e carregamento do CLI), `npm run test:integration-credentials` (aplicação transacional, escopos e idempotência). Nenhuma prova de acesso ao Google real é produzida por esses testes.

Referência: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get

## Etapa 4.7 — Conector Google Drive e importação de fotos

O leitor Sheets aceita opcionalmente `AUTOFLOW_STOCK_DRIVE_FOLDER_ID`, o ID de uma pasta dedicada, compartilhada como leitora com a mesma conta de serviço. Habilitar também a API Google Drive no projeto Google Cloud. Com essa configuração, a autenticação solicita os escopos de leitura Sheets e Drive. Não há escrita no Google. Sem o ID, a leitura Sheets continua funcionando como antes.

A raiz deve conter somente pastas diretas de veículos. O nome de cada pasta deve corresponder exatamente ao código de estoque após normalização (maiúsculas, sem espaços). Pastas desconhecidas, duplicadas, atalhos, subpastas ou formatos não suportados provocam falha da rodada; `anuncio.txt` com MIME text/plain é ignorado. Fotos aceitas: JPEG, PNG e WebP. Pastas de veículos vendidos não têm seu conteúdo baixado. Não se presume venda nem se remove foto quando uma pasta não existe. Não se usa correspondência aproximada.

O conector percorre a paginação da API Drive, recusa listagens incompletas e verifica tamanho e SHA-256 dos bytes reais. Limites: 500 pastas, 100 arquivos por pasta, 2.000 imagens, 12 MiB por imagem, 256 MiB por rodada; o limite local de 20 fotos por veículo continua vigente. Não segue redirecionamentos. Esses limites são escolhas conservadoras, ajustáveis após homologação. A prévia não comprova a autenticidade comercial ou a validade visual da foto. O servidor verifica conteúdo no upload.

Fluxo manual autorizado:
1. `node scripts/stock-sheet.mjs` — prévia conjunta, usando escopo local vehicles:read.
2. `node scripts/stock-sheet.mjs --apply-drafts` — criação de novos rascunhos com os escopos existentes da etapa 4.6.
3. `node scripts/stock-sheet.mjs --upload-photos` — nova leitura e prévia, com escopos locais vehicles:read e photos:write. Só considera fotos novas de registros locais inalterados, completos, explicitamente disponíveis e sem conflitos na prévia. O endpoint de upload revalida credencial, código de estoque, hash, conteúdo, status Rascunho, trabalhos protegidos e capacidade. Fotos de novos veículos ainda não cadastrados ou de registros com diferenças são adiadas. A opção de upload é separada da criação; não pode ser combinada na mesma invocação.

Cada foto é baixada novamente e comparada ao hash da prévia. Uma falha interrompe a sequência, com contagem parcial; fotos já aceitas não são revertidas. Repetir após nova prévia é idempotente para o mesmo conteúdo. Não se substitui a galeria nem se cria publicação. A ordem do manifesto não garante a ordem desejada das fotos; revisão no painel continua necessária.

Testes offline: `npm run test:stock-drive`, `npm run test:stock-sheet`, `npm run test:integration-credentials`. Não houve homologação com uma conta Google real. A configuração de fontes, sincronização periódica, tratamento autorizado de alterações e vendas e liberação operacional continuam pendentes.

## Etapa 4.8 — Execução periódica local, opt-in

O runner `node scripts/stock-sync-runner.mjs` executa uma rodada quando devida e termina; com `--watch`, continua no processo local, sem depender do agendador de publicações. Não é instalado nem iniciado automaticamente pelo Docker. Executar a partir da instalação principal, depois de configurar e homologar as fontes e a credencial local conforme 4.6/4.7. O processo precisa de Node 24 e dependências instaladas. As variáveis secretas devem ser fornecidas pelo ambiente seguro do usuário; não inserir tokens em comandos registrados ou arquivos versionados.

- `AUTOFLOW_STOCK_SYNC_INTERVAL_MINUTES`: intervalo após o término da rodada, padrão 30 minutos, mínimo 5 e máximo 1440.
- `node scripts/stock-sync-runner.mjs --watch`: somente prévias recorrentes (padrão). Sem criação de veículos ou fotos.
- `--mode=drafts`, `--mode=photos`, `--mode=drafts-and-photos`: modos explícitos de escrita, respeitando os escopos e revalidações da API. O último executa criação de rascunhos primeiro e, se bem-sucedida, nova leitura/prévia e envio de fotos. Requer pasta Drive configurada. Não aplica vendas, alterações de registros existentes ou promoção para Pronto.
- `node scripts/stock-sync-runner.mjs --status`: consulta a última rodada concluída e a próxima previsão (timestamps Unix em milissegundos).

O arquivo `data/stock-sync-runner.sqlite` é um SQLite separado do banco de estoque. A transação de escrita nele impede sobreposição entre instâncias que compartilham **o mesmo arquivo local**; não mantém o banco de estoque bloqueado durante chamadas externas. A próxima rodada é persistida, inclusive em reinicializações. Falhas duplicam o intervalo até o máximo de 24 horas e interrompem os passos seguintes. Uma rodada bem-sucedida retorna ao intervalo normal. São mantidas as últimas 100 rodadas com contagens, fase da falha e horários, sem tokens, IDs de fontes, nomes de arquivos ou mensagens brutas do provedor.

O modo é escolhido em cada invocação; uma rodada ainda não devida não é antecipada ao mudar o modo. O modo watch pode ser encerrado com Ctrl+C, aguardando a rodada atual. Não há prazo global por rodada além dos limites e timeouts de requisição dos conectores. Em interrupção abrupta, o bloqueio SQLite é liberado pelo sistema operacional, mas uma operação externa/local já aceita pode ter ocorrido sem o registro final; a rodada seguinte revalida e usa os endpoints idempotentes. Não há transação distribuída entre Google, estoque e galeria.

O bloqueio não cobre invocações manuais do CLI antigo nem cópias do repositório com arquivos de estado diferentes. Usar somente a instalação principal para execução real e não agendar o CLI antigo em paralelo. Um único arquivo serve a uma configuração local de fonte; não há orquestração multi-tenant de fontes neste runner. O agendamento no Windows, inicialização automática após reinício e integração do status com painel/Telegram ainda não foram configurados. A sincronização real e permissões Google continuam sem homologação.

Teste offline: `npm run test:stock-sync-runner`. O teste usa duas conexões no mesmo SQLite temporário e funções de leitura/escrita simuladas; não acessa o Google nem o estoque real.

## Etapa 4.9 — Aplicação individual de alterações e vendas revisadas

A resposta da prévia passa a incluir `reviewedActions`, uma lista de candidatos restritos, para fonte declarada completa. Cada candidato contém ação, ID local, código, valores antes/depois, horário da revisão, validade de cinco minutos e digest de comparação. O digest vincula organização, fonte declarada, linha normalizada e estado local observado; não é segredo, assinatura, autenticação da origem nem prova de aprovação humana.

Ações disponíveis:
- `update_price_km`: somente Rascunho, dados cadastrais completos, diferença restrita ao preço ou quilometragem, preço e km inteiros e quilometragem não decrescente.
- `record_sale`: somente venda explícita com correspondência local, status Rascunho ou Pronto e sem venda já registrada.
- Ambas exigem código único, chassi de 17 caracteres compatível com o cadastrado, ano/marca/modelo coincidentes, ausência de conflito de fotos para a linha e ausência de qualquer registro local em trabalhos, ledger de anúncios e hashes de anúncios, inclusive histórico cancelado/removido. Sem chassi confirmado, o fluxo existente do painel permanece necessário. A inexistência de histórico local não comprova inexistência de anúncio externo.

Para executar uma única ação, o administrador deve emitir credencial específica com `vehicles:read` e `stock:update` ou `stock:sell`, conforme o caso. Não há concessão automática a credenciais anteriores. Após revisão humana da fonte, veículo e valores, enviar `POST /api/integration/v1/stock/reviewed-action` com `confirm: "apply_reviewed_stock_action"`, `action`, `vehicleId`, `reviewedAt`, `digest` e `snapshot` (o envelope usado na prévia). O servidor revalida a credencial e recalcula o candidato sob transação de escrita. Referências vencidas, divergentes ou não elegíveis retornam 409. Não se reaplica uma alteração já efetuada enquanto o estado atual for diferente; o digest não é um token de uso único armazenado.

Uma gravação aceita registra ação, ID e antes/depois no log de auditoria da integração, na mesma transação. Não altera fotos, fila, anúncio externo ou outras linhas. Vendas de veículos com qualquer histórico de publicação e alterações fora dos limites continuam no fluxo manual existente; esta rota não substitui o tratamento de trabalhos em andamento do painel. Não se infere venda por ausência, não se reabre vendido e não se altera identidade ou descrição.

O runner periódico não ganhou modo de atualização ou venda. A confirmação individual é um contrato de API para operador autorizado, não uma interface interativa implementada no painel. A credencial com escopo de escrita deve ficar separada da credencial do runner. Não usar confirmação gerada automaticamente para contornar a revisão. Os testes HTTP são locais e não comprovam origem Google, efeito externo ou aprovação real. A homologação da fonte e a configuração operacional permanecem pendentes.
