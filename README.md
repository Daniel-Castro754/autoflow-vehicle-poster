# AutoFlow — MVP Vehicle Poster

Painel inicial para estoque, atribuição de vendedores e acompanhamento da fila de publicação de veículos.

## Rodar localmente

```powershell
npm install
$env:AUTH_SECRET = "substitua-por-um-segredo-aleatorio-com-32-caracteres"
$env:INITIAL_ADMIN_EMAIL = "voce@empresa.com"
$env:INITIAL_ADMIN_PASSWORD = "uma-senha-inicial-forte"
npm run dev
```

Na primeira execução com um banco vazio, `INITIAL_ADMIN_EMAIL` e `INITIAL_ADMIN_PASSWORD` criam o administrador inicial. A senha deve ter pelo menos 12 caracteres. Nas execuções seguintes, somente `AUTH_SECRET` continua obrigatório. Use `CORS_ORIGINS` para liberar origens adicionais do painel, separadas por vírgula; por padrão, somente `http://localhost:5173`, `http://127.0.0.1:5173` e extensões do Chromium podem acessar a API.

A API escuta somente em `127.0.0.1` por padrão. `HOST` altera a interface de rede conscientemente, e `PUBLIC_ORIGIN` define a origem usada nas URLs de imagens quando ela for diferente de `http://HOST:PORT`. A extensão local espera a API em `http://127.0.0.1:3333`.

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
- Extensão experimental para Brave em `extension-mv2/`
- Fila da extensão e preenchimento assistido do Marketplace
- Tema claro/escuro persistente por navegador
- Central de notificações com atalhos operacionais
- Menu lateral funcional em telas móveis
- Cadastro e edição completa dos dados do Marketplace
- Galeria de até 20 fotos por veículo, com reordenação e capa definida pela primeira foto
- Validação obrigatória antes de entrar na fila (preço, quilometragem, localização, descrição e fotos)
- Seleção individual e em massa com exclusão confirmada
- Menus de ações por veículo
- Extensão com preenchimento sequencial e upload de fotos, com ritmo variável entre campos
- Estrutura visual para múltiplos vendedores e contas
- Ajuda contextual acessível com indicadores `?` e avisos `!`
- Fila isolada por trabalho e perfil ativo do Brave
- Retorno de preenchimento com campos encontrados, pendências, fotos e versão da extensão
- Estados operacionais `Pendente`, `Preenchendo`, `Aguardando confirmação`, `Concluída` e `Erro`

As lacunas encontradas na comparação com ferramentas similares e o roadmap recomendado estão em [COMPETITIVE_ANALYSIS.md](./COMPETITIVE_ANALYSIS.md).

O banco de desenvolvimento fica em `data/autoflow.db` e não deve ser versionado. Antes de produção, migre o banco para PostgreSQL. Nenhuma credencial ou sessão do Facebook é armazenada.

Para testes isolados, `DATA_DIR` permite escolher outra pasta de banco e uploads, e `PORT` altera a porta da API e as URLs de imagens retornadas pelo servidor. A extensão permanece configurada para a porta padrão `3333`.
