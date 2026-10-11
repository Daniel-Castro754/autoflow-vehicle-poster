# Ensaio de restauração isolada — AutoFlow

A área **Saúde e autonomia → Assistente de correção guiada → Verificar backup e restauração** oferece agora duas verificações diferentes:

1. **Verificar integridade:** compara hashes dos arquivos e verifica o SQLite sem copiar a restauração.
2. **Ensaiar restauração isolada:** após confirmação explícita, valida a cópia, cria uma pasta temporária no sistema operacional, restaura nela o banco SQLite, o cofre e as fotos, abre o banco restaurado em modo somente leitura e remove a pasta de teste.

Nenhuma das duas operações altera o **DATA_DIR** do AutoFlow em execução, cria anúncios, abre o Facebook, reinicia o servidor ou substitui arquivos do backup original.

## Passo a passo

1. Crie um backup com `npm run backup -- create .\\backups`. Para copiar uploads e banco de forma consistente, prefira realizar a operação com o AutoFlow parado.
2. Inicie o AutoFlow como administrador e abra **Saúde e autonomia**.
3. Expanda **Verificar backup e restauração** e clique em **Localizar cópias disponíveis**.
4. Escolha uma cópia reconhecida e clique em **Ensaiar restauração isolada**. Confirme a intenção no diálogo.
5. Confira a mensagem final: quantidade de veículos, usuários, imagens e confirmação de limpeza dos arquivos temporários.

O sistema copia o backup para uma pasta sob `os.tmpdir()`, verifica o banco restaurado (`PRAGMA integrity_check` e tabelas de empresas, veículos e usuários), a cópia do cofre e a quantidade de imagens. A pasta temporária é removida ao fim, inclusive por proteção adicional do processo principal se o verificador ultrapassar o tempo limite.

O resultado inclui `restoredFiles: true`, `databaseOpened: true`, `bootProbePassed: true`, `applicationStarted: false`, `dpapiValidated: false` e `temporaryRemoved: true` somente quando o ensaio foi concluído com sucesso. A abertura HTTP é restrita ao diagnóstico; o aplicativo funcional completo não é iniciado. Veja [Teste de inicialização restrita](RESTORED_BOOT_SMOKE_TEST.md).

## Segurança e limitações

- Executa apenas sob comando de um **administrador autenticado**, e a API exige a confirmação específica `TESTAR_RESTAURACAO_ISOLADA`.
- O servidor só aceita backups da pasta fixa `./backups` (ou `AUTOFLOW_BACKUP_ROOT` configurado no ambiente); rejeita caminhos arbitrários, symlinks e diretórios de formato inesperado.
- **Instalações com múltiplas empresas continuam bloqueadas**, porque os backups são globais e contêm dados de todos os tenants.
- Há limite de um processo de verificação de backup por vez, de **três minutos** para o ensaio, **8 GB** de dados e checagem prévia de espaço livre no disco temporário.
- O subprocesso recebe apenas variáveis básicas do ambiente, sem chaves de IA ou Telegram. Nenhum conteúdo do banco é enviado à interface, além dos contadores agregados.
- Inicia somente um processo do servidor em **modo diagnóstico local e somente leitura**, sem trabalhadores autônomos e sem rotas operacionais. Não testa migrações de versão, login, extensão Facebook, credenciais Gemini/OpenAI ou se o DPAPI pode ser aberto por outro usuário Windows.
- Mesmo após ensaio bem-sucedido, ainda é importante realizar um teste operacional de recuperação sob o mesmo usuário Windows, ou preparar o pacote de recuperação portátil antes de migrar entre perfis.
- Se o programa informar falha de limpeza, verifique manualmente a pasta temporária do sistema. Não compartilhe os arquivos restaurados.
- O ensaio executa no sistema onde o servidor AutoFlow está rodando, **não** no navegador.

## Testes

`npm run test:backup-verification` agora valida restauração isolada bem-sucedida, limpeza da pasta temporária, prevenção de path traversal, recusa de backups adulterados, preservação do banco principal e bloqueio de vendedores/ambientes com múltiplas organizações. Os mesmos testes também são executados no Windows durante o CI.

O indicador geral **Backup e recuperação** continua usando `Não verificado` porque a evidência do ensaio ainda não é persistida no banco, e porque uma execução isolada não equivale à validação completa de uso e migração do sistema.
