# AutoFlow Integration API v1

## Objetivo

Expor uma superfície segura e versionada para ChatGPT e outras integrações sem acesso direto ao SQLite e sem reutilizar sessões humanas do painel.

## Princípios

- credenciais de integração separadas das sessões de usuário;
- tokens persistidos somente como SHA-256;
- escopos mínimos por capacidade;
- isolamento obrigatório por organization_id;
- auditoria de acesso;
- expiração e revogação;
- v1 inicial somente leitura;
- nenhuma rota de integração pode contornar aprovação de texto/fotos, duplicidade, capacidade, fila, retry ou ledger.

## Escopos iniciais

- status:read
- vehicles:read
- publications:read
- accounts:read

## Endpoints iniciais

- GET /api/integration/v1/status
- GET /api/integration/v1/vehicles
- GET /api/integration/v1/publications
- GET /api/integration/v1/accounts

## Próximas fases

1. administração segura de credenciais pelo painel;
2. testes de autenticação, escopo, tenant isolation, expiração/revogação e auditoria;
3. detalhe de veículo/publicação e analytics read-only;
4. cadastro de veículo como rascunho;
5. upload de fotos e curadoria;
6. geração/preview/aprovação de texto reutilizando os serviços existentes;
7. comandos operacionais com preview + confirmação explícita.

Ações mutáveis serão adicionadas por escopos próprios e nunca compartilharão os escopos read-only.
