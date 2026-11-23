# Validade dos anúncios do Marketplace

Em **Publicações → Validade dos anúncios**, o Auto Flow apresenta os anúncios
confirmados que continuam registrados como ativos. A organização começa com
o controle habilitado, validade de quatro dias (96 horas) e aviso de 24 horas.
Somente administradores alteram a regra geral. Vendedores visualizam e tratam
os anúncios dos seus próprios perfis.

- A contagem começa em `first_confirmed_at`, nunca na criação do veículo,
  agendamento, preenchimento ou última consulta.
- O prazo é configurável de 1 a 90 dias; prorrogações individuais acrescentam
  1 a 30 dias ao maior valor entre o prazo atual e a hora da prorrogação.
- Vendidos aparecem primeiro, independentemente da idade e da configuração.
- Anúncios antigos sem confirmação confiável aparecem como **Data a revisar**.
  Anúncios sem link identificável devem ser conferidos em Seus classificados.
- O painel consulta o servidor a cada minuto enquanto está aberto.
  O aviso é um indicador visual, não uma notificação externa.
- A política não cria tarefas de publicação, não republica e não clica no
  Facebook. Use o perfil indicado, verifique o anúncio e retire-o manualmente.
- Só depois da retirada no Marketplace, clique em **Confirmar retirada**.
  O botão registra a declaração do operador, preserva veículo, fotos e
  histórico, e usa a transição de remoção já existente.
- Alterar a política ou prorrogar o prazo nunca altera o estado externo.
  Prorrogações são registradas no histórico do trabalho.

## Teste supervisionado

Execute `npm run test:listing-expiry`. Em um ambiente de teste, verifique
o limite exato de 96 horas, os avisos, vendidos, anúncios antigos sem
evidência, prorrogação e isolamento entre perfis/organizações. Não é
necessário excluir nem criar anúncios reais para validar esses cenários.
