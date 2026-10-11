# Teste de inicialização restrita sobre um backup restaurado

A área **Saúde e autonomia → Assistente de correção guiada → Verificar backup e restauração → Ensaiar restauração isolada** agora inclui uma checagem adicional: **inicialização do núcleo HTTP do AutoFlow em modo de diagnóstico, com banco de dados restaurado em somente leitura**.

## O que acontece

1. O administrador seleciona um backup existente, na pasta autorizada do servidor, e confirma o ensaio.
2. O worker valida o backup e restaura uma cópia em um diretório temporário do sistema operacional.
3. Confere hashes, SQLite, tabelas de empresas/usuários/veículos e arquivos de upload.
4. Executa a aplicação `server/server.ts` em **modo restrito de diagnóstico** usando a cópia do banco em **somente leitura**, porta aleatória em `127.0.0.1` e segredo efêmero gerado apenas para o teste.
5. O processo de verificação confirma a rota `GET /health/ready` com desafio secreto temporário; confirma que requisições sem o desafio recebem 403 e tentativas de chamar a publicação automática recebem 404 mesmo com o desafio.
6. Encerra o servidor temporário, confirma que o hash do banco restaurado permaneceu igual, e elimina a pasta temporária.

O processo de verificação **não recebe credenciais reais** do AutoFlow. A cópia do banco não é usada para criar publicação, remessa, postagem, grupos ou filas, e não modifica o banco original.

## Limites precisos

O modo diagnóstico não inicia Health Monitor, curadoria automática nem piloto automático. A autenticação, extensões e demais rotas ficam inacessíveis. A abertura do banco e a consulta de prontidão são exercitadas, mas o aplicativo não inicia com todas as funções habilitadas.

**Não são testados:** login, migração do esquema, abertura das chaves criptografadas DPAPI, integração Gemini/OpenAI, webhooks, extensão Brave, sessão Facebook ou publicação real. Um teste bem-sucedido significa **inicialização restrita aprovada**, não recuperação operacional integral.

O resultado inclui:
- `bootProbePassed: true`: inicialização e resposta do diagnóstico aprovadas;
- `probeDatabaseReadOnly: true`: a cópia do SQLite foi aberta somente para leitura;
- `backgroundWorkersStarted: false`: nenhum dos trabalhadores periódicos foi ativado;
- `applicationStarted: false`: não foi iniciado o serviço operacional completo;
- `dpapiValidated: false`: as credenciais não foram descriptografadas;
- `temporaryRemoved: true`: cópia temporária removida após encerramento.

## Proteção do ambiente principal

O teste usa apenas diretórios temporários, com timeout, limite de tamanho e recusa de instalações que tenham múltiplas empresas. A porta HTTP é escolhida pelo sistema e só aceita conexões locais. A rota de diagnóstico exige um token aleatório interno, e todas as outras rotas são negadas.

O código executa a mesma entrada de servidor de produção em um modo restrito, nunca com flags de automação ativa. Evite executar manualmente `AUTOFLOW_RESTORE_BOOT_PROBE` em instâncias de uso normal: o modo existe apenas para validação dos backups.

O PR permanece separado até validar o CI de Linux e Windows e homologar o painel no Windows 10 do usuário.
