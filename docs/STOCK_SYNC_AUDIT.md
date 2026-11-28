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
