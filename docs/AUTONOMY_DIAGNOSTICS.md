# Diagnóstico de autonomia — primeira etapa

- Extensão: histórico local limitado a 200 decisões, com exportação JSON por perfil. Repetições iguais são agregadas temporalmente (até cinco minutos).
- Docker: a presença envia a última decisão observada do perfil. O log pode repetir a mesma decisão; use o campo at para identificar a ocorrência original.
- Trabalho: o relatório final e o evento execution_diagnostics no histórico persistem etapas e tempos relativos, inclusive falhas de download e confirmação das fotos. Consulte /api/publications/:id/timeline.
- Os eventos são diagnósticos, não prova de publicação. A confirmação e as proteções existentes continuam obrigatórias.
- Nenhum endereço de imagem, segredo, HTML ou texto arbitrário novo é incluído nos diagnósticos.
- Não há migração do banco. Histórico local não é compartilhado entre perfis do Brave e é limpo no logout. Se o content script cair antes de enviar o resultado, a trilha parcial ainda pode ser perdida.
- Ainda faltam painel central agregado, exportação do servidor, trilha em tempo real por tentativa e validação no Facebook.

Validação: npm run test:execution-diagnostics, npm run test:extension-consumer, npm run typecheck, npm run lint e npm test.
