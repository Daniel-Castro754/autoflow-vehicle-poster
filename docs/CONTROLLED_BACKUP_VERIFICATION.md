# Verificação controlada de backups no painel AutoFlow

O painel **Saúde e autonomia → Assistente de correção guiada → Verificar backup e restauração** permite **listar** e **verificar a integridade** de cópias existentes de forma deliberada. Nenhuma cópia é criada, restaurada, removida ou alterada pelo painel.

## Como funciona

1. O administrador expande o roteiro **Verificar backup e restauração**.
2. Clica em **Localizar cópias disponíveis**. Essa operação lista até 30 pastas de backup reconhecidas, ordenadas pela data no nome, sem ler os arquivos para confirmar integridade.
3. Seleciona uma cópia e clica em **Verificar integridade**. Uma confirmação explícita é exibida.
4. Um processo separado, limitado a 120 segundos, executa a mesma verificação do comando `npm run backup -- verify <diretório>`.

A verificação inclui SHA-256 do SQLite e de cada upload listado no manifesto, `PRAGMA integrity_check`, imagens referenciadas pelo banco e presença e hash do arquivo `vault-key.json` quando necessário. A resposta inclui data da checagem, tamanho do banco, número de imagens e se o arquivo do cofre está presente, sem conteúdo de arquivos, tokens, segredos, URLs ou caminhos completos.

**Integridade aprovada NÃO significa restauração testada.** A interface informa explicitamente `A restauração continua não testada`. O indicador geral de restauração permanece `Não verificado` até existir um ensaio separado, intencional e seguro de restauração em diretório isolado.

## Pasta autorizada

Por padrão o AutoFlow busca cópias em `./backups`, relativas ao diretório onde `npm run dev` foi iniciado. Este é o mesmo destino usado nas instruções `npm run backup -- create ".\\backups"`.

É possível configurar uma pasta de backup autorizada, **somente pelo servidor**, definindo a variável de ambiente `AUTOFLOW_BACKUP_ROOT`. A interface **nunca aceita caminhos absolutos ou arbitrários** do navegador. Só são reconhecidas pastas com o nome gerado pelo AutoFlow (`autoflow-backup-YYYY-MM-DDTHH-MM-SS.mmmZ`). Pastas e arquivos simbólicos não são aceitos.

## Proteções

- Somente administrador autenticado; endpoint protegido e `Cache-Control: no-store`.
- **Instalações com múltiplas empresas bloqueadas**: o backup contém o banco de **todas** as organizações. Uma conta administrativa de uma empresa não deve listar nem verificar esse material. A futura solução multitenant requer um serviço de backups com autorização de escopo do host.
- O `GET /api/health/backups` apenas lista pastas elegíveis.
- O `POST /api/health/backups/verify` exige o identificador de uma pasta autorizada, confirmação na interface e não grava informações no banco.
- Nunca abre links simbólicos e não segue caminhos de diretórios enviados pelo navegador.
- Só uma verificação executa por vez; os cálculos de hashes e o SQLite ficam isolados em subprocesso com timeout de dois minutos para não travar o servidor.
- O subprocesso retorna mensagens de erro normalizadas e nunca inclui paths, tokens ou conteúdo dos arquivos.
- **Não gera backups automaticamente** e não faz testes de restauração sobre o `DATA_DIR` atual.

## Limitações

- Uma cópia pode ser íntegra mas ser antiga, incompleta em termos de continuidade de negócio, incompatível com outra conta Windows DPAPI ou não restaurável em outra máquina; isso deve ser testado separadamente.
- A proteção contra acesso a arquivos arbitrários usa restrição de caminho e rejeição de links simbólicos, mas não substitui permissões de sistema operacional e isolamento de backups de várias empresas.
- A lista usa as 30 pastas mais recentes pelo nome; cópias exportadas manualmente com outro padrão ainda podem ser verificadas pelo CLI `npm run backup -- verify "<caminho>"`.
- Se a cópia estiver em um disco externo, configure `AUTOFLOW_BACKUP_ROOT` no ambiente do servidor e reinicie o AutoFlow. Não cole caminhos de backup em formulários web.

## Testes

- `npm run test:backup-verification`: confirma autorização, recusa em ambientes multitenant, rejeição de paths/symlinks, preservação dos arquivos e detecção de corrupção.
- `npm run test:backup`: regressão da criação, cópia e restauração manual.
