# Fase 6 — Etapa 2 de 4: áreas operacionais

## Objetivo

Aplicar os tokens semânticos de `src/design-system.css` da primeira etapa às três áreas
que concentram o fluxo de trabalho: **Central de IA, Veículos e Publicações**.
A implementação é incremental, por página, para não alterar métodos ou permissões.

## Central de IA

- Cabeçalho menos carregado: a ação principal do piloto fica **uma única vez** no seu
  cartão, e o topo mantém apenas a atualização da auditoria.
- Nova introdução visual **Preparar → Agendar → Acompanhar**.
- Indicadores com tipografia e espaçamento consistentes.
- Quando a auditoria não está disponível, não apresentar nota 100% nem
  um perfil de publicação fictício: exibir `—` ou aviso correspondente.
- A janela sugerida não promete tráfego/alcance do Facebook.
- Bloco de preparação com os sinais conhecidos (`activeAccounts`, `readyVehicles`)
  e aviso explícito de que o piloto obedece às regras existentes de confirmação.
- Passos do piloto apresentados em lista legível, sem afirmar publicação 100% autônoma.
- Assistente com altura de conversa controlada e área de entrada em destaque.
- Não alteramos os handlers de piloto, comandos ou criação de veículos.

## Veículos

- Filtros rápidos **Todos, Prontos, Publicados, Atenção e Rascunhos**.
  São atalhos ao filtro de status já implementado no servidor
  (`GET /api/vehicles/paged?status=...`), portanto preservam a paginação
  por organização e não usam somente os 25 itens carregados.
- Mudança de filtro zera a seleção, retorna à primeira página e atualiza o resultado.
- Indicador de veículos sem fotos com a contagem já fornecida pelo resumo da API.
  Não foi criado um filtro por foto inexistente no servidor.
- Removido o botão não funcional **Todas as lojas**, substituído por uma informação
  não interativa: **Organização atual**.
- Tabela, fotos, status, busca e mensagens vazias mais legíveis.
- Os fluxos de importação CSV, edição, exclusão, venda e envio para fila não foram alterados.

## Publicações

- Introdução de uma seção **Operação de publicações**, com perfis online / perfis totais.
- Aviso quando nenhum perfil local Brave está associado.
- Acesso direto à fila filtrada: **Ver pendentes**, **Revisar erros** e
  **Todos os trabalhos**. Atalhos usam os filtros de status já existentes,
  reiniciam paginação e limpam seleção anterior.
- Distinção visual entre Central de automação e Fila e histórico com `aria-pressed`.
- Filtros/tabelas legíveis, alinhamento e responsividade do painel de perfis.
- Fila não assume que uma execução foi publicada só porque começou.
  Ações de pausa, reprocessamento, confirmação manual e proteção contra duplicatas
  continuam exatamente como estavam.

## Estilos e responsividade

- `src/operational-workspaces.css` carregado **depois** de `design-system.css`.
  Regras escopadas nas três páginas, sem mudar estilos do login, relatórios
  ou configurações.
- Cores e superfícies derivadas de `--af-*`, preservando claro/escuro.
- Quebras em 1200 px e 720 px, filtros com quebra de linha; tabelas largas
  mantêm rolagem **no container**, sem gerar layout quebrado.
- Estados hover e foco preservados. Ajustar demais páginas nas etapas 3 e 4.

## Validação de CI

A `main` anterior executava `npm test` na CI, mas não tinha uma entrada
`test` definida em `package.json`. Nesta etapa, passamos a executar
explicitamente as 24 suítes `test:*` do projeto, incluindo
`npm run test:operational-ui`, com o mesmo `npm test`.
A suíte nova verifica a semântica dos filtros, preservação dos comandos,
responsividade, ausência de filtros inertes e carregamento correto de CSS.

CI: Node.js 22.18.0 e 24, lint, Prettier, typecheck, build web,
build da extensão, `npm test`, auditoria de dependências e Docker.

## Homologação visual antes de publicar

No Brave local (`npm run dev`), verificar cada página em 1440 / 1024 / 768 /
390 pixels nos dois temas. Revisar filtros rápidos em estoque >25 veículos,
alternância Central/Fila, login ativo e seleções, e executar piloto apenas em
dados de teste. **CI não substitui testes reais da extensão/Facebook.**

Nenhuma migração ou alteração de schema, autenticação, API ou publicação
foi introduzida nesta etapa.
