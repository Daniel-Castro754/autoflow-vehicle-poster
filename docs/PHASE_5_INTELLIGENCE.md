# Fase 5 — agendamento baseado em evidências e sincronização segura do estoque

## Agendamento orientado pelos resultados do AutoFlow

O agendador usa os resultados **operacionais** de `publication_jobs` nos últimos 180 dias,
com o horário de **início da tentativa** (`started_at`), e não a hora em que o
preenchimento terminou. A métrica é publicações concluídas / tentativas com
resultado conhecido (`completed` ou `error`). Pendências, retries ainda
em fila, trabalho em andamento e anúncios de resultado incerto ficam fora
dessa avaliação.

A seleção deixa de premiar horários apenas pelo volume de anúncios
concluídos: utiliza taxa de conclusão com suavização Bayesiana
`(completed + 2)/(attempts + 4)` e exige **20 tentativas terminais na
organização e pelo menos 4 no horário analisado**.

Mesmo com dados suficientes, um horário histórico só é escolhido se
estiver disponível nas próximas **72 horas** e respeitar o espaçamento
existente. Sem evidência suficiente ou horários adequados, usa as janelas
heurísticas preexistentes. A inteligência é aplicada ao piloto
automático recorrente e aos comandos de agendamento inteligente.

A Visão geral apresenta a amostra, a taxa e os melhores horários.
`GET /api/operations/scheduling-insights` exige autenticação e limita
os resultados à organização da sessão.

**Importante:** conclusão operacional NÃO mede visualizações, alcance,
leads, vendas nem algoritmo interno do Facebook. Não há qualquer alegação
de melhoria garantida de engajamento. Não foram adicionadas chamadas a
APIs privadas do Facebook.

## Estoque: sincronização CSV supervisionada

A importação CSV já existia. Agora a interface:

1. Solicita o modo (criar/atualizar).
2. Executa uma prévia `POST /api/vehicles/import` com `dryRun: true`.
   As operações são executadas numa transação SQLite e **desfeitas**;
   o resultado inclui contagens e `previewDigest`.
3. Exibe novas inserções, atualizações, ignorados e erros.
4. Só confirma após concordância explícita. O commit inclui
   `previewDigest`, calculado a partir do CSV, modo e fotografia
   atual dos veículos/trabalhos da organização.
5. Se o estoque mudar entre prévia e commit, a API responde 409 e
   exige nova prévia.

Veículos vinculados a publicações ativas (`pending`, `filling`, `error`,
`awaiting_confirmation`, `completed`) não são sobrescritos
silenciosamente pela sincronização CSV. Linhas protegidas aparecem como
ignoradas e com aviso de revisão. Os controles anteriores de VIN/código
de estoque e status `Vendido`/`Publicado` foram preservados.

A API antiga sem token de prévia permanece compatível com integrações
legadas; o cliente web novo sempre usa a prévia. Uma integração externa
que requeira consistência deve enviar o digest retornado pelo dry-run.

Não há fonte autoritativa externa conectada nesta fase: a sincronização
é **por CSV fornecido pelo operador**, não por API de concessionária,
ERP ou marketplace. Itens ausentes de um CSV não são marcados como
vendidos e anúncios não são removidos automaticamente.

## Testes e implantação

`npm run test:intelligence` cobre escolha por taxa vs volume,
amostra insuficiente, limite de 72h, prévia que não altera o banco,
commit, proteção contra prévia desatualizada, trabalho ativo e estoque
entre organizações. Executar também `npm test`, lint, build e Docker.

Esta fase não adiciona migration. Homologar no Brave com dados reais
antes de ajustar limites ou habilitar automação em escala.
