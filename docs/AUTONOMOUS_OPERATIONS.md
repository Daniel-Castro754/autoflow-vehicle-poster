# Operação autônoma e observabilidade

## Agendamento recorrente

Em **Configurações → Agendar estoque automaticamente**, um administrador pode ativar o worker e escolher o intervalo entre rodadas (1–1.440 minutos, padrão 5). Esta opção começa desligada em bancos existentes: ativar publicação automática não passa a cadastrar novos jobs silenciosamente. O clique automático em Publicar, o avanço de etapas e o consumo autônomo da fila mantêm as configurações atuais.

A API verifica organizações elegíveis a cada 30 segundos e ao iniciar. Uma rodada longa adia a próxima varredura. Cada rodada cria até 20 jobs para veículos prontos, com dados e fotos suficientes, respeitando duplicidades, perfis conectados, capacidade diária, fuso e espaçamento. O restante é considerado nas rodadas seguintes. Descrições incompletas usam o provedor de IA já configurado e podem consumir créditos; o modo procedural continua disponível.

O intervalo é contado após o término da rodada, inclusive quando não há veículos elegíveis ou ocorre erro. Habilitar a opção ou mudar o intervalo torna a organização elegível novamente. Comandos manuais continuam disponíveis com a recorrência desligada.

A migration 9 adiciona configurações e `autopilot_state`, sem modificar migrations anteriores. A trava é por organização, compartilhada por comandos manuais, pela Central de IA e pelo worker. Expira em dois minutos e é renovada a cada 20 segundos. Uma execução expirada não pode renovar nem liberar a trava de um novo proprietário. Não há transação SQLite aberta durante chamadas à IA.

Antes de inserir, a transação confere novamente a propriedade da execução, a configuração, o estoque, fotos, descrições, duplicidades e capacidade. Veículos vendidos ou com dados usados na descrição alterados durante a resposta da IA ficam fora daquela rodada. Desligar a recorrência impede novas inserções da rodada em preparação; jobs já criados permanecem na fila. Nenhuma confirmação manual extra foi acrescentada.

Os eventos `autopilot_scheduled` distinguem `details.trigger = recurring` ou `manual`; rodadas automáticas usam `created_by = NULL`. O painel mostra o estado e resultado da última rodada. Falhas detalhadas ficam nos logs.

## Saúde e métricas

- `GET /api/health` permanece público e retorna somente disponibilidade básica.
- `GET /api/health/detailed` exige sessão válida e retorna apenas dados da organização autenticada. Não executa recuperações nem envia alertas.
- `GET /api/metrics` usa a mesma autenticação e o mesmo isolamento, em texto compatível com Prometheus. Não existe endpoint global anônimo. Ambos os endpoints detalhados usam `Cache-Control: no-store`.

Um coletor deve enviar `Authorization: Bearer <sessão>` e renovar a sessão conforme sua validade; a sessão atual expira em 12 horas e pode ser revogada. Não foi introduzido token de monitoramento permanente. Não coloque credenciais em URLs ou no repositório.

O card **Saúde da operação**, na Visão geral, atualiza a cada 30 segundos após a consulta anterior terminar. Falhas de atualização são exibidas com indicação de dados antigos; respostas após desmontagem são descartadas.

Definições:

| Indicador                                      | Critério                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Na fila / em execução / aguardando confirmação | Estado atual do job, incluindo jobs pausados na fila                                     |
| Travados                                       | `filling`, sem lease válido e duração acima do timeout configurado                       |
| Execuções demoradas                            | `filling`, lease válido e duração a partir de 75% do timeout                             |
| Publicados em 24h                              | Estado atual `completed` ou `removed`, com `filled_at` nas últimas 24h                   |
| Em erro em 24h                                 | Estado atual `error`, atualizado nas últimas 24h                                         |
| Sucesso por perfil                             | Publicados ÷ (publicados + em erro), com os critérios acima; sem resultados, exibe traço |
| Tempo médio                                    | Segundos de `started_at` a `filled_at`, somente publicados em 24h com intervalo válido   |
| Recuperações / avisos em 24h                   | Eventos `stalled_recovered` / `job_nearly_stuck` registrados no período                  |

Os indicadores são fotografias do estado atual, não um histórico imutável de todas as tentativas. Retentativas e exclusões podem reduzir contagens; por isso as séries Prometheus são gauges. O tempo médio é omitido nas métricas quando não há amostras. A taxa mede conclusão operacional, não engajamento ou vendas.

## Avisos de demora

O monitor registra `job_nearly_stuck` a partir de 75% do timeout, somente para execuções com lease válido. A emissão não cancela, pausa nem reinicia o job. A recuperação de travamentos mantém suas regras e roda antes desses avisos.

A migration 9 guarda a tentativa avisada no próprio job. A marca e o evento são gravados atomicamente antes do envio: há no máximo uma tentativa de entrega por execução, mesmo após reiniciar a API ou com múltiplos processos. Uma nova execução (`attempt_count`) pode gerar novo aviso. O orçamento de retry (`retry_count`) não é alterado.

São processados até dez avisos por varredura, com envio concorrente e timeout existente dos canais. O evento registra resultados de entrega. Se houver falha de rede ou interrupção após gravar a marca, esse aviso não é reenviado automaticamente; ele continua visível nas métricas. Alertas críticos continuam separados.

## Identificação das requisições

Toda resposta inclui `X-Request-Id`. Um identificador recebido só é aceito se tiver 1–64 caracteres alfanuméricos ou `._:-`, começando por alfanumérico; caso contrário a API gera UUID. O identificador acompanha os logs assíncronos da requisição e o registro HTTP com método, caminho sem query string, status e duração. Corpo, cookies e cabeçalhos de autorização não são registrados. O campo é exposto por CORS.

## Validação

`npm run test:operations` cobre sessões anônimas/revogadas, isolamento entre organizações, métricas, configuração, concorrência entre conexões SQLite, exclusão mútua manual/worker, cadência persistida, recuperação de lease, falha isolada por organização, venda/edição durante descrição, desativação durante rodada e avisos deduplicados mesmo com falha de entrega. Os demais testes cobrem a fila e a publicação automática existentes. Todos usam bancos temporários e bloqueiam chamadas HTTP externas.

Esta entrega não inclui previsão de engajamento, troca automática de seletores nem alegação de auditoria imutável por hashes. A publicação real no Facebook/Brave continua exigindo homologação no navegador.
