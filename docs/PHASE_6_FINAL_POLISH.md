# Fase 6 — Etapa 4/4: acabamento, responsividade e acessibilidade

## Entrega final do redesign

Integra os ajustes das etapas 1–3 com uma camada de acabamento
`src/final-polish.css`, importada **após** `management-workspaces.css`.
Nenhuma rota API, migração, agendamento ou lógica de publicação foi alterada.

## Melhorias de navegação por teclado

- Menu lateral móvel abre como uma navegação modal com rótulo acessível.
- `Tab` e `Shift+Tab` permanecem nos controles do menu enquanto aberto.
- `Escape` fecha e devolve o foco ao botão que abriu o menu. O menu também
  fecha quando a janela retorna à largura de desktop, e a rolagem da página
  fica bloqueada enquanto o menu está aberto.
- Página ativa anunciada com `aria-current=page`; botão informa
  `aria-controls` e `aria-expanded`.
- `DrawerFocusGuard` torna as gavetas de Equipe, Veículos, Publicações,
  agendamentos, transferência de perfil e linha do tempo acessíveis:
  `role=dialog`, `aria-modal`, nome, foco inicial,
  `Escape`, ciclo Tab e retorno do foco ao gatilho.
- Botões de fechar da fila e agendamentos ganham rótulos descritivos.
- Notificações têm rótulo e fecham com `Escape`.
- Feedback efêmero é anunciado via `role=status` e `aria-live=polite`.
- As quatro tabelas grandes (Veículos, fila e duas em Relatórios) têm
  `role=region`, `aria-label`, `tabIndex=0` e indicação visível de foco;
  a rolagem horizontal fica limitada ao contêiner.

## Responsividade

- 1200 px: redução proporcional de espaçamento e de lacunas dos cartões.
- 900 px: navegação móvel em painel sobreposto com botão de fechar.
- 600 px: cartões empilhados, formulários e filtros dimensionados e
  **textos dos botões de ação mantidos visíveis** (antes havia
  `font-size: 0` herdado no cabeçalho móvel).
- Gavetas com `100dvh`, largura máxima da tela, rolagem interna e
  foco/fechamento utilizáveis até larguras pequenas.
- Tabelas grandes preservam colunas e rolam dentro do painel, sem forçar
  toda a página a uma largura de desktop.
- Impressão de Relatórios sem menu/controles, com conteúdo e cores legíveis.
- Preferência `prefers-reduced-motion` respeitada.

## Contraste e estados

Usa os tokens existentes; `tests/phase-six-final-polish.mjs` comprova
contraste **pelo menos 4,5:1** nas combinações centrais de texto normal,
texto secundário e botões principais, nos temas claro/escuro.
Os estados `focus-visible`, vazio, erro, aviso e botões desabilitados
têm aparência consistente. Essa verificação não equivale a auditoria
WCAG completa de cada componente legado.

## Validação automatizada

- Nova `npm run test:design-final`, incluída em `npm test` (26 suítes).
- Confere rotulagem/contagem dos oito modais, fluxo Esc/Tab,
  navegação do menu, retorno de foco, rolagem acessível das quatro tabelas,
  textos de ações no celular, impressão, contraste e ordenação do CSS.
- CI: Node.js 22.18.0 / 24, typecheck, lint, formatação, Web/Extensão,
  26 suítes de testes, auditoria de dependências e build Docker.

## Critérios de homologação manual (ainda pendentes)

1. Brave: temas claro/escuro, viewport 1440, 1024, 768, 390 e 320 px.
2. Menu no celular: `Tab`, `Shift+Tab`, `Escape`, fechar pelo botão e
   alternar entre celular/desktop.
3. Abrir e fechar as gavetas de Veículos, Equipe e Publicações; conferir
   retorno do foco e preservação de campos/seleções.
4. Tabelas grandes: foco visível e rolagem horizontal dentro da tabela.
5. Relatórios sem amostra: **Sem dados** em vez de 0%; impressão/print preview.
6. Validar chamadas e salvamento em um banco de testes. Não publicar anúncios
   reais somente para homologar aparência.

**Escopo:** etapa 4 conclui a implementação planejada de UX/UI. O teste visual
com navegador real e eventual correção de detalhes visuais observados nessa
homologação continuam necessários antes do deploy. Manter branch isolada até
revisão e merge consciente.
