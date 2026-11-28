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
