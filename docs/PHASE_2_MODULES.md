# Fase 2 — Separação de módulos do AutoFlow (primeira entrega)

## Inventário validado

- **Catálogo de veículos:** já possui serviços de importação e rotas de leitura/gravação.
- **Fotografias:** otimização, curadoria e entrega assinada de mídia.
- **Facebook Marketplace:** rotas de publicação, extensão, grupos, agenda e leitura.
- **Sessões:** lógica de seleção de perfis existente em `session-manager.ts`.
- **Instagram:** ainda não existe integração funcional no repositório; não adicionamos permissões ou publicações fictícias.

## Refatoração aplicada

- `server/modules/media.ts` passa a ser o único ponto de atendimento HTTP
  das fotografias públicas e variantes autorizadas.
- `server/modules/vehicles.ts` reúne as entradas de leitura, curadoria e mutação
  do domínio de veículos.
- `server/modules/facebook-marketplace.ts` reúne os pontos de entrada do
  Facebook Marketplace (extensão, leitura, gestão, agendamento e grupos).
- `server/server.ts` permanece o compositor dos módulos, preservando
  a ordem original das rotas e a autenticação.

As URLs, o formato das respostas, o banco SQLite, as assinaturas HMAC,
as políticas de duplicidade e as regras de publicação não foram modificados.

## Próximas separações

- Extrair a coordenação das filas para um módulo de execução independente.
- Separar lifecycle de sessão de autenticação e de publicação.
- Criar contrato de adaptador de plataforma antes de qualquer integração Instagram;
  usar apenas mecanismos autorizados da plataforma.
- Reforçar testes de integração para os novos limites dos módulos.

## Validação

Executar `npm run typecheck`, `npm run lint`, `npm test`,
`npm run build` e `npm run format:check`.

## Segunda entrega — sessões e filas compartilhadas

- `server/modules/accounts.ts` passa a conter a seleção de contas elegíveis,
  incluindo limites diários e critérios de capacidade. O caminho anterior
  `server/services/session-manager.ts` continua disponível como reexportação
  para preservar compatibilidade.
- `server/modules/publication-queue.ts` concentra a composição das rotas de
  consulta, gerenciamento e agendamento da fila, além do lifecycle do
  agendador autônomo já existente.
- O módulo Facebook mantém somente as rotas específicas da extensão e dos grupos.
  A ordem das chamadas no servidor continua a mesma para evitar alterações
  em autenticação, autorização e comportamento de publicação.
- Testes de fronteira verificam os pontos de entrada da fila e a equivalência
  do seletor de contas anterior e novo.

**Limites:** esta etapa não introduz Instagram, adaptadores oficiais, novos
estados de filas nem alterações de esquema SQLite. A seleção de contas ainda
consulta `social_accounts`, como antes; a generalização do modelo de perfis
para outras plataformas será uma etapa posterior.
