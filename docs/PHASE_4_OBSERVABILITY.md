# Fase 4 — Central de intervenções e observabilidade

## Objetivo

Persistir problemas que exigem acompanhamento humano **no servidor**, independentemente de
reinício do Brave ou do dispositivo do operador. Esta fase não substitui o registro
de eventos de publicação já existente; faz uma projeção operacional dele.

## Modelo e segurança

A migration 14 cria as tabelas `operational_incidents` e
`operational_incident_actions`. O par organização/trabalho/tipo identifica uma
ocorrência: reincidências aumentam `occurrence_count`; uma ocorrência previamente
encerrada é reaberta, com nova ação de auditoria. Ações incluem abertura,
reabertura, reconhecimento, encerramento e encerramento automático.

A migração inicial recupera trabalhos que estavam em `error` ou aguardando
confirmação **com indício de clique em Publicar**. Aguardando confirmação normal,
sem tentativa de publicar, não gera um alerta crítico retroativo.

Eventos de erro de preenchimento, publicação incerta, disjuntor de seletores,
possível duplicidade, execução lenta e travamentos do monitor geram ocorrências
persistentes. Eventos de resolução comprovada encerram os alertas correspondentes.

**Reconhecer não é resolver.** Reconhecimento/encerramento na central não alteram
status, leases, evidências ou agenda do anúncio. Ocorrências de publicação
incerta não podem ser encerradas enquanto o trabalho estiver
`awaiting_confirmation`; primeiro deve-se confirmar o resultado em Publicações.

## API

Todos os endpoints exigem sessão válida e estão isolados por `organization_id`.

| Endpoint | Finalidade |
| --- | --- |
| `GET /api/operations/incidents?status=active&limit=30` | Fila de ocorrências, prioridades e totais |
| `GET /api/operations/incidents/:id/history` | Histórico de reconhecimento e resolução |
| `GET /api/operations/activity?limit=30&beforeId=...` | Linha do tempo de eventos, com filtro `jobId` |
| `PATCH /api/operations/incidents/:id` | `{"action":"acknowledge"}` ou `{"action":"resolve"}` |

Somente administradores podem reconhecer ou encerrar. A leitura segue o
escopo organizacional do painel existente. Resultados têm `Cache-Control: no-store`,
limite de até 100 entradas e não retornam credenciais nem detalhes brutos
de eventos.

## Interface

A Visão geral exibe a **Central de intervenções**, com filtros, severidade,
perfil/veículo, contadores, histórico de ações e últimas tentativas. O painel
faz consultas a cada 30 segundos. As notificações locais do sino continuam
existindo; nesta fase, a fonte persistente dos alertas operacionais é a central.

## Operação e limites

Faça backup do SQLite antes de aplicar a migration 14. A migração não remove
jobs, altera anúncios no Facebook nem desfaz bloqueios anteriores.

Um alerta de execução lenta, por exemplo, pode fechar automaticamente quando
a execução avança. Um resultado incerto nunca libera republicação por conta
própria. A entrega externa por Telegram/webhook permanece independente desta
central; a persistência de ocorrências **não garante** entrega de mensagens
externas quando esses canais falham.

Valide com `npm run test:observability` e `npm test` e homologue o
comportamento com uma extensão Brave real antes de integrar produção.
