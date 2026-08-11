# AutoFlow — MVP Vehicle Poster

Painel inicial para estoque, atribuição de vendedores e acompanhamento da fila de publicação de veículos.

## Rodar localmente

```bash
npm install
npm run dev
```

## Acesso de demonstração

- E-mail: `admin@autoflow.local`
- Senha: `demo1234`

O comando `npm run dev` inicia o painel em `http://localhost:5173` e a API em `http://localhost:3333`.

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
- Extensão com preenchimento sequencial e upload de fotos
- Estrutura visual para múltiplos vendedores e contas
- Ajuda contextual acessível com indicadores `?` e avisos `!`
- Fila isolada por trabalho e perfil ativo do Brave
- Retorno de preenchimento com campos encontrados, pendências, fotos e versão da extensão
- Estados operacionais `Pendente`, `Preenchendo`, `Aguardando confirmação`, `Concluída` e `Erro`

As lacunas encontradas na comparação com ferramentas similares e o roadmap recomendado estão em [COMPETITIVE_ANALYSIS.md](./COMPETITIVE_ANALYSIS.md).

O banco de desenvolvimento fica em `data/autoflow.db` e não deve ser versionado. Antes de produção, configure `AUTH_SECRET` e migre o banco para PostgreSQL. Nenhuma credencial ou sessão do Facebook é armazenada.

Para testes isolados, `DATA_DIR` permite escolher outra pasta de banco e uploads, e `PORT` altera a porta da API.
