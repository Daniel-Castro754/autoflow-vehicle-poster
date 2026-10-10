# Assistente de correção guiada — AutoFlow

A área **Saúde e autonomia** agora apresenta um roteiro de revisão para cada condição local classificada como **Atenção**, além de uma verificação separada para **backup não verificado**.

## Funcionamento

A consulta `GET /api/health/readiness` retorna o campo `guides`, calculado a partir dos indicadores atuais. São roteiros **estáticos e determinísticos** escritos na própria aplicação; **não são sugestões geradas por Gemini/OpenAI**, nem interpretam comandos escritos pelo usuário.

Cada roteiro contém motivo, prioridade, etapas de verificação, área recomendada para abrir e limite de segurança. A interface permite expandir o roteiro e marcar etapas como **conferidas localmente**, sem persistir esse estado. **Marcar todas as etapas não significa que o problema foi resolvido.** O botão `Reavaliar diagnóstico` consulta novamente o estado real.

As prioridades atuais são: problemas de credenciais legadas e fila/publicação incerta; grupos/perfis/piloto automático; configurações incompletas de IA e Telegram; e verificação independente de backup.

## Limites de segurança

- Não existe endpoint de execução ou correção automática. Todas as respostas são de **leitura**, escopadas por organização e acessíveis somente a administradores.
- Não remove, reativa, desativa, reordena ou importa grupos automaticamente.
- Não chama APIs externas, testa credenciais, envia alertas, inicia piloto automático, cria jobs ou faz tentativas de publicação.
- Para publicações de resultado incerto, orienta conferir manualmente o Facebook **antes** de tentar publicar novamente.
- Para credenciais legadas e grupos, orienta backup e preservação dos dados antes de alterações.
- O conteúdo dos roteiros é fixo, sem interpolar URLs, segredos, textos da empresa ou campos externos potencialmente maliciosos.
- O backup continua classificado como **não verificado**: a existência de uma recomendação não comprova restauração bem-sucedida.

## Testes

`npm run test:guided-remediation` valida ordenação de prioridades, instruções estáticas, resistência a IDs não reconhecidos, não vazamento de conteúdo externo e ausência de ações mutantes.

`npm run test:readiness` valida autorização, isolamento de empresas e nenhuma escrita após sucessivas consultas.

A evolução futura pode incluir verificações controladas específicas (como backup), mas cada operação deverá ter escopo explícito, consentimento e testes independentes antes de ser adicionada ao assistente.
