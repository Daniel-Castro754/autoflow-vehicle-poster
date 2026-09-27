# AutoFlow — MVP Vehicle Poster

Painel inicial para estoque, atribuição de vendedores e acompanhamento da fila de publicação de veículos.

## Rodar localmente

Requer Node.js 22.18.0 ou superior; Node.js 24 LTS é a versão recomendada (`nvm use`).

```powershell
npm install
$env:AUTH_SECRET = "substitua-por-um-segredo-aleatorio-com-32-caracteres"
$env:INITIAL_ADMIN_EMAIL = "voce@empresa.com"
$env:INITIAL_ADMIN_PASSWORD = "uma-senha-inicial-forte"
npm run dev
```

Na primeira execução com um banco vazio, `INITIAL_ADMIN_EMAIL` e `INITIAL_ADMIN_PASSWORD` criam o administrador inicial. A senha deve ter pelo menos 12 caracteres. Nas execuções seguintes, somente `AUTH_SECRET` continua obrigatório. Use `CORS_ORIGINS` para liberar origens adicionais do painel, separadas por vírgula; por padrão, somente `http://localhost:5173`, `http://127.0.0.1:5173` e extensões do Chromium podem acessar a API.

A API escuta somente em `127.0.0.1` por padrão. `HOST` altera a interface de rede conscientemente, e `PUBLIC_ORIGIN` define a origem usada nas URLs de imagens quando ela for diferente de `http://HOST:PORT`. A extensão local espera a API em `http://127.0.0.1:3333`.

O login aceita por padrão até 5 tentativas por conta/endereço e 30 tentativas totais por endereço em uma janela de 15 minutos. `LOGIN_MAX_ATTEMPTS`, `LOGIN_IP_MAX_ATTEMPTS` e `LOGIN_WINDOW_SECONDS` permitem ajustar esses limites.

O comando `npm run dev` inicia o painel em `http://localhost:5173` e a API em `http://127.0.0.1:3333`.

## Escopo atual

- Dashboard responsivo de veículos
- Busca e filtro por status
- Indicadores de estoque e publicação
- Cadastro persistente de veículos
- Login com sessão assinada e senha protegida por scrypt
- Banco SQLite local com isolamento por empresa
- Modelos para equipe, contas sociais e fila de publicação
- Tela de equipe com criação de vendedores
- Associação de responsáveis a perfis locais do Brave
- Estado de conexão preparado para a extensão
- Extensão Manifest V3 experimental para Brave em `extension-mv2/` (nome legado do diretório)
- Fila da extensão e preenchimento assistido do Marketplace
- Tema claro/escuro persistente por navegador
- Central de notificações com atalhos operacionais
- Menu lateral funcional em telas móveis
- Cadastro e edição completa dos dados do Marketplace
- Galeria de até 20 fotos por veículo, com reordenação e capa definida pela primeira foto
- Validação obrigatória antes de entrar na fila (preço, quilometragem, localização, descrição e fotos)
- Upload de imagens JPG, PNG e WebP com decodificação completa e limite de 40 milhões de pixels
- Localização padrão e modelo de descrição configurados pela organização aplicados quando o cadastro deixa esses campos em branco
- Seleção individual e em massa com exclusão confirmada
- Menus de ações por veículo
- Extensão com preenchimento sequencial e upload de fotos, com ritmo variável entre campos
- Estrutura visual para múltiplos vendedores e contas
- Ajuda contextual acessível com indicadores `?` e avisos `!`
- Fila isolada por trabalho e perfil ativo do Brave
- Lease renovado somente por mensagens do content script da mesma aba e documento; uma aba aberta e o alarme do worker não mantêm uma execução viva
- Retorno de preenchimento com campos encontrados, pendências, fotos e versão da extensão
- Estados operacionais `Pendente`, `Preenchendo`, `Aguardando confirmação`, `Concluída` e `Erro`
- O piloto automático aplica os mesmos requisitos de publicação da fila normal, incluindo campos completos, fotos válidas e proteção contra anúncios duplicados
- Agendamento recorrente configurável por organização, com execução exclusiva entre o worker e comandos manuais
- Saúde operacional no painel, métricas autenticadas por organização e avisos de demora sem repetição por tentativa
- Retentativas automáticas são limitadas a falhas transitórias reconhecidas, respeitam o máximo configurado e nunca repetem um clique de publicação sem confirmação

As lacunas encontradas na comparação com ferramentas similares e o roadmap recomendado estão em [COMPETITIVE_ANALYSIS.md](./COMPETITIVE_ANALYSIS.md).

O banco de desenvolvimento fica em `data/autoflow.db` e não deve ser versionado. SQLite é o armazenamento suportado atualmente; PostgreSQL não é pré-requisito para produção sem uma necessidade operacional medida. Nenhuma credencial ou sessão do Facebook é armazenada.

## Backup e restauração

O backup inclui um snapshot consistente do SQLite, todos os uploads e um manifesto SHA-256. Pare a API antes de criá-lo para manter banco e arquivos sincronizados:

```powershell
$env:DATA_DIR = ".\data"
npm run backup -- create ".\backups"
npm run backup -- verify ".\backups\autoflow-backup-<timestamp>"
npm run backup -- restore ".\backups\autoflow-backup-<timestamp>" ".\restore-test"
```

A restauração só aceita um destino inexistente ou vazio. Faça ensaios periódicos em uma pasta separada e mantenha as cópias em outro dispositivo; o manifesto detecta corrupção, mas não substitui armazenamento redundante.

Para testes isolados, `DATA_DIR` permite escolher outra pasta de banco e uploads, e `PORT` altera a porta da API e as URLs de imagens retornadas pelo servidor. A extensão permanece configurada para a porta padrão `3333`.

## Configuração e validação

Copie `.env.example` para `.env` e preencha `AUTH_SECRET`, `INITIAL_ADMIN_EMAIL` e `INITIAL_ADMIN_PASSWORD`. Os campos de segredo ficam vazios de propósito. O fuso operacional padrão é `America/Sao_Paulo`; `SCHEDULE_TIMEZONE` aceita um identificador IANA e governa o agendamento, o histórico e a contagem diária, independentemente do fuso do computador.

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` e `npm test` são os mesmos gates da CI. Os testes usam bancos temporários e bloqueiam HTTP externo; não publicam no Facebook nem enviam alertas reais. `LOG_LEVEL` aceita `info`, `warn` e `error`; os logs são JSON com campos sensíveis ocultos.

Para ativar a criação periódica da fila, use **Configurações → Agendar estoque automaticamente** e escolha o intervalo. A configuração **Publicar automaticamente** continua independente. Detalhes sobre limites, métricas, logs e alertas estão em [Operação autônoma e observabilidade](docs/AUTONOMOUS_OPERATIONS.md).

## Container local

```sh
docker build -t autoflow .
docker run --rm --env-file .env -p 127.0.0.1:3333:3333 -v autoflow-data:/app/data autoflow
```

O container serve o painel compilado e a API na porta 3333, como usuário sem privilégios. Banco e fotos ficam no volume `/app/data`. Para acesso remoto, configure `PUBLIC_ORIGIN` e `CORS_ORIGINS` com as origens reais. A extensão continua usando a API local.
