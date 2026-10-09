# Fase 1 — integridade da publicação

Esta entrega separa jobs criados de execuções iniciadas, protege contra duplicidades e impede que o monitor sobrescreva uma execução cujo lease foi renovado.

## Proteções

- O limite diário da extensão conta eventos `filling_started` (inclusive retentativas), no fuso comercial. Não conta jobs que ainda aguardam execução.
- O limite, a aquisição do lease e o evento `filling_started` são verificados/gravados na mesma transação `BEGIN IMMEDIATE`.
- Migration 12 adiciona índice parcial único em `(organization_id,vehicle_id)` para os estados `pending`, `filling`, `error`, `awaiting_confirmation` e `completed`.
- O monitor só recupera um job se continuar no estado `filling`, com o mesmo `lease_token` e com lease ainda expirado. Uma recuperação perdida não registra evento nem alerta de sucesso.

## Antes de atualizar um banco em produção

Faça backup e execute:

```sql
SELECT organization_id,vehicle_id,COUNT(*) quantidade,GROUP_CONCAT(id) job_ids
FROM publication_jobs
WHERE status IN ('pending','filling','error','awaiting_confirmation','completed')
GROUP BY organization_id,vehicle_id HAVING COUNT(*) > 1;
```

Se houver conflitos, reconcilie o estado dos anúncios no Marketplace antes de migrar. A migration **não descarta nem cancela anúncios** e vai falhar se o índice encontrar duplicatas preexistentes.

## Testes e limitações

Execute `npm run test:phase-one` e `npm test`. A suíte de Fase 1 cobre a primeira reserva mesmo com jobs pré-agendados, bloqueio após consumir o limite, exclusão mútua por veículo e preservação de lease renovado.

**Fora deste escopo:** a cota usada ao **criar** jobs continua baseada no dia de criação, mesmo para agendamentos futuros; o aprimoramento de reservas por dia de execução fica para a fase de orquestração. Sessões da extensão ainda expiram em 12 horas e serão tratadas na fase 2. A publicação real no Facebook precisa de homologação no Brave.
