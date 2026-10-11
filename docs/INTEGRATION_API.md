# AutoFlow Integration API v1

## Objetivo e estado

API versionada para clientes autorizados, incluindo uma futura conexão com ChatGPT. A existência dos endpoints não significa que um conector ChatGPT esteja instalado ou que a API esteja exposta publicamente. A integração é operada com tokens próprios e não utiliza sessões humanas do painel.

**Estado:** implementação inicial incorporada ao repositório; a validação de CI ainda deve ser concluída antes de uso em produção.

## Autenticação

Todas as rotas em `/api/integration/v1` exigem `Authorization: Bearer afi_...`. Os tokens são gerados aleatoriamente, armazenados apenas como SHA-256, vinculados a uma organização e podem ser revogados. O token completo é mostrado apenas na resposta de criação.

A criação e revogação de tokens exige sessão humana ativa com privilégio de administrador.

| Método | Endpoint | Acesso |
| --- | --- | --- |
| GET | `/api/integrations/credentials` | Administrador; lista metadados, sem token/hash |
| POST | `/api/integrations/credentials` | Administrador; cria token e retorna segredo uma vez |
| POST | `/api/integrations/credentials/:id/revoke` | Administrador; revoga token |

Corpo para criação: `{"name":"ChatGPT","scopes":["vehicles:read","reports:read"],"expiresAt":"2027-01-01T00:00:00Z"}`. `expiresAt` é opcional, mas é recomendado definir uma validade. O máximo aceito é 366 dias.

**Segurança:** nunca envie tokens em mensagens, issues, commits ou capturas de tela. Não reutilize o token de integração como login do painel.

## Escopos

| Escopo | Operação |
| --- | --- |
| `status:read` | Consultar estado da API |
| `vehicles:read` | Listar veículos |
| `publications:read` | Consultar jobs de publicação |
| `accounts:read` | Consultar contas sociais |
| `vehicles:create` | Criar veículo em rascunho |
| `photos:write` | Enviar foto a veículo em rascunho |
| `reports:read` | Consultar relatório mensal |

Os escopos são independentes. Um token com leitura não ganha permissão de escrita. A API isola os dados pelo `organization_id` do token.

## Rotas de leitura

| Método | Endpoint | Escopo |
| --- | --- | --- |
| GET | `/api/integration/v1/status` | `status:read` |
| GET | `/api/integration/v1/vehicles` | `vehicles:read` |
| GET | `/api/integration/v1/publications` | `publications:read` |
| GET | `/api/integration/v1/accounts` | `accounts:read` |
| GET | `/api/integration/v1/reports/monthly?month=2026-10` | `reports:read` |

As listagens de veículos e publicações retornam no máximo 250 registros por consulta; não há paginação implementada nesta versão.

O relatório mensal retorna `month`, `period`, `publicationJobsCreatedInMonth` e `currentInventorySnapshot`. Os jobs são filtrados pela **data de criação**, mas classificados pelo **status atual**; o estoque também é um retrato atual, não um fechamento histórico. Não interprete esses números como eventos de publicação ocorridos no mês.

## Cadastro de veículo

`POST /api/integration/v1/vehicles` exige `vehicles:create` e um objeto JSON com os dados do veículo, seguindo as validações já usadas no painel. Campos como `year`, `make`, `model`, `price`, `km`, `vehicleType`, `transmission`, `fuelType`, `bodyType`, `condition`, `exteriorColor` e `interiorColor` precisam usar os valores aceitos pelo AutoFlow. `location` e `description` podem usar os padrões da organização.

O status é sempre forçado a `Rascunho`. Identificadores de estoque e chassi são validados contra duplicidade. Resposta de sucesso: HTTP 201, `{"id":123,"status":"Rascunho","requiresReview":true}`.

## Envio de fotos

`POST /api/integration/v1/vehicles/:id/photos` exige `photos:write` e aceita:

```json
{
  "name": "frente.jpg",
  "mimeType": "image/jpeg",
  "dataBase64": "<conteúdo base64 da imagem>"
}
```

Formatos aceitos: JPEG, PNG e WebP. Máximo de 12 MB por imagem e 20 imagens por veículo. A API valida a imagem decodificada, verifica duplicidade por hash SHA-256 e só aceita upload para veículo da mesma organização com status `Rascunho`. Respostas de sucesso incluem `requiresReview: true`.

**O upload não aprova curadoria, não gera publicação e não agenda publicação.** A seleção de fotos e as aprovações continuam obrigatórias pelo fluxo existente.

## Erros e auditoria

- HTTP 400: corpo, imagem, parâmetros ou dados inválidos;
- HTTP 401: token ausente, inválido, expirado ou revogado;
- HTTP 403: token sem escopo suficiente;
- HTTP 404: recurso inexistente ou fora da organização;
- HTTP 405: método não permitido;
- HTTP 409: duplicidade ou conflito de estado/limite.

Ações e consultas relevantes geram eventos em `integration_audit_events`. A integração não fornece acesso direto ao banco.

## Fases ainda não concluídas

1. Estabilizar formatação, CI e testes end-to-end.
2. Integrar geração, prévia e aprovação de descrições sem contornar as regras existentes.
3. Melhorar relatórios com métricas históricas verificáveis e paginação.
4. Implementar conector ChatGPT com autenticação e confirmação explícita para ações sensíveis.
5. Validar implantação e exposição segura da API antes de habilitar acesso remoto.
