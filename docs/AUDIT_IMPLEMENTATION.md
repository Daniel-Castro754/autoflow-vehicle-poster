# Implementação da auditoria em blocos

Base auditada: `169d55f9c1bb297e5d71601d48b7f664602f4505`.

## Bloco 1 — Consistência de estoque e publicação

Implementado:

- Venda cancela trabalhos não iniciados em uma transação; execuções iniciadas ou aguardando confirmação ficam pausadas, ocultas e pendentes de conferência.
- Veículo vendido não entra na fila, não pode ser preparado, retomado, exibido novamente na extensão ou redistribuído para outro perfil.
- O heartbeat não renova uma execução após a venda.
- Antes do clique automático em Publicar, a extensão consulta `/publish-check`; se o servidor rejeitar ou estiver indisponível, o clique não ocorre.
- Resultados tardios da execução interrompida podem registrar a publicação sem desfazer a venda. O anúncio aparece como pendente de remoção.
- Confirmação manual preserva Vendido; a remoção do último anúncio de um veículo não vendido retorna o veículo a Pronto. Outros anúncios legados ativos são respeitados.
- Uma edição cuja requisição começou antes da venda não consegue sobrescrever Vendido quando termina de chegar.
- Data original da venda preservada em chamadas repetidas; histórico registra interrupção por venda.
- Interface remove Adicionar à fila de veículos vendidos e oferece reconciliação de trabalhos interrompidos.

### Validação

- `npm run test:stock`: regressões de venda pendente/em execução, requisição concorrente, resultado atrasado, erro após venda, confirmação manual, retomada bloqueada, preflight e remoção com/sem outro anúncio ativo.
- `npm run test:queue`: regressões existentes.
- `npm run build` e `npm run lint`.

### Atualização e limites

Atualizar backend, painel e recarregar a extensão **0.13.1** em `brave://extensions`. Abas já abertas podem manter o content script antigo: encerrar/conferir trabalhos em andamento e reabrir a página de criação após atualizar.

Não há migração de schema neste bloco. Não corrige retroativamente registros antigos inconsistentes sem conferência do operador.

A checagem anterior ao clique reduz a janela de concorrência, mas não torna uma ação no Facebook atômica com uma venda no banco. Se o clique já ocorreu, o resultado é reconciliado preservando a venda e solicitando remoção. A publicação manual feita diretamente no Facebook não é controlada pelo servidor.

Não foi executada publicação real no Facebook nem teste em Brave/Windows. A extensão ainda tem os problemas de vinculação de abas e entrega de resultado identificados na auditoria. Manter publicação automática desativada até validar o bloco 2.

## Bloco 2 — Próxima entrega: execução confiável da extensão

Pendente: vínculo job/lease/aba/documento; renovação condicionada à atividade; tratamento de aba fechada; intenção de publicação persistida; resultado idempotente com confirmação de recebimento e reenvio; conferência estrita de campos/fotos.

## Bloco 3 — Cadastro, upload, configurações e acesso

Pendente: recuperação de upload parcial sem duplicar veículo; decodificação real de imagens; defaults e template aplicados; normalização de e-mail/senha; ciclo de vida de usuários/sessões; política explícita de fotos e limite diário.

## Bloco 4 — Painel, métricas e manutenção

Pendente: atualização coordenada de fila/indicadores; agregações e carregamento limitado; métricas por data e responsável corretos; ações conforme permissões; acessibilidade; runtime documentado; modularização, migrations e backup restaurável.
