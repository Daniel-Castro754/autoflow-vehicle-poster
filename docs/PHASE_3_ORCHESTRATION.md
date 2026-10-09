# Fase 3 — orquestração autônoma e retries seguros

## Execução por organização

O worker mantém um pool **limitado de organizações em paralelo**. Padrão: 3, máximo: 4, configurável por `AUTOPILOT_MAX_PARALLEL_ORGS` no servidor (`1` a `4`). Isso reduz o efeito de uma chamada lenta de IA bloquear outras organizações, sem criar um número irrestrito de chamadas externas.

- Cada organização preserva o lease transacional compartilhado entre worker e acionamento manual.
- A API nunca mantém transação SQLite aberta enquanto aguarda chamadas externas de IA.
- Uma falha em uma organização é registrada nos logs e não cancela as demais.
- Rodadas periódicas não se sobrepõem. `stop()` impede iniciar novas organizações, mas não encerra à força uma rodada já em andamento.
- O worker **não repete automaticamente uma rodada inteira** após erro, pois parte dela pode ter sido confirmada no banco. A próxima rodada obedece ao agendamento persistente.

## Falhas da extensão

Somente códigos explícitos permitidos são elegíveis para auto-retry **quando ainda não existe evidência de tentativa de publicação** e a organização habilitou a política:

| Código | Categoria | Ação |
| --- | --- | --- |
| `marketplace_form_timeout` | Transitório | Retry com backoff e orçamento existente |
| `marketplace_navigation_timeout` | Transitório | Retry com backoff e orçamento existente |
| `facebook_auth_required` | Autenticação | Intervenção manual |
| `facebook_checkpoint_required` | Autenticação | Intervenção manual |
| `photo_identity_unverified` | Segurança | Revisão manual |
| `selector_layout_drift` | Segurança | Revisão manual |
| `publish_outcome_unknown` | Segurança | Confirmação manual no Facebook |
| `vehicle_data_invalid` | Validação | Corrigir cadastro, sem retry |
| Código ausente ou desconhecido | Desconhecido | Sem auto-retry |

O evento `auto_retry_scheduled` registra categoria e tratamento adotado. O evento `fill_error` informa se precisa de intervenção. No retorno da API, o cliente também recebe `failureCategory` e, quando não houve retry, `requiresIntervention`.

**Regras mantidas:** sem reenvio automático depois de clique incerto em Publicar; tentativa com lease inválido é rejeitada; orçamento de retry é finito; apenas falhas reconhecidamente transitórias permitem reagendamento. A automação não tenta contornar login nem CAPTCHA.

## Verificação

Execute `npm run test:orchestration` e `npm test`. Os novos testes avaliam limite de concorrência, progresso de outra organização enquanto uma trava, falha isolada por organização, `stop()` e políticas de falha seguras.

Homologação com navegador real continua necessária; aumentar o paralelismo entre organizações não significa abrir múltiplas publicações simultâneas no mesmo perfil do Facebook.
