# Fase 6 — Etapa 3 de 4: Relatórios, Configurações e Equipe

## Escopo

Aprimorar a leitura, organização visual e navegação das três áreas administrativas,
respeitando o Design System das etapas 1 e 2. Esta etapa **não** modifica APIs,
modelo de dados, permissões, lógica de publicação ou autenticação.

## Relatórios

- Introdução de cartões explicando os recortes: **estoque atual** da organização;
  **publicações no período escolhido**; e **conclusões do AutoFlow**, não leads ou
  vendas comprovadas.
- Menus de desempenho/ocorrências agora expõem estado selecionado com `aria-pressed`.
- Filtro de período mantém seu comportamento anterior, sem mudar retroativamente
  a posição do estoque.
- Cartões e tabelas maiores, com tipografia legível e contraste nos temas
  claro e escuro.
- Taxa de conclusão com denominador zero = **Sem dados**, e 0% somente quando há
  trabalhos no período sem nenhuma conclusão. Cobertura fotográfica e proporção
  do estoque publicado seguem a mesma regra de amostra.
- Tratamento de falha da API: a tela mostra diagnóstico com opção de tentar novamente,
  ou aviso de possível desatualização quando existe informação carregada.
  Não mistura falha de carregamento com um indicador operacional de zero.
- Funil mantém quantidade de cada etapa; percentuais sem amostra mostram
  **Sem trabalhos no período**. Histórico de ocorrências e as verificações
  obrigatórias antes de reprocessar publicações permanecem intactos.

## Configurações

- Navegação por 6 assuntos: Empresa, Marketplace, Inteligência artificial,
  Notificações, Aparência e Segurança.
- Navegação leva aos cartões reais no mesmo formulário (`scrollIntoView`).
  **Não esconde ou desmonta** entradas de configuração, preservando validação
  HTML de campos obrigatórios e valores ainda não salvos.
- Interruptores de configuração mais claros, incluindo estado ativado,
  desativado, bloqueado e foco de teclado. Todas as dependências já existentes
  entre avanço automático e publicação permanecem.
- Token do Telegram mascarado ao digitar, tal como as chaves de IA.
- Botões de aparência com `aria-pressed` e bloco de salvar com esclarecimento
  de que todas as alterações são confirmadas juntas.
- As alterações do tema continuam sendo aplicadas imediatamente e armazenadas
  no navegador, como já ocorria no código original.

## Equipe e contas

- Quatro indicadores **derivados dos dados reais**: acessos ativos, perfis
  associados à organização, perfis com automação pausada e perfis sem responsável
  ativo.
- **Perfis associados não são classificados como online.** A confirmação de
  conexão depende da extensão local do Brave.
- Indicadores são atalhos navegáveis para Pessoas e Perfis; cartões e tabelas
  têm hierarquia de texto e ações mais legível.
- Mantidos controles condicionados às permissões administrativas, formulário
  de criação de usuário, vínculo com perfil Brave, desativação/reativação e
  retomada da automação. Sem mudança nos handlers.
- Botões de ação importantes têm descrições acessíveis.

## Design e testes

- `src/management-workspaces.css`: estilos específicos das três áreas,
  carregados após a folha das etapas anteriores.
- Acessibilidade de foco, tipografia, temas claro/escuro e responsividade
  básica em 1180 px e 740 px, sem alterar telas fora do escopo.
- `src/management-metrics.ts`: cálculos puros de percentuais e equipe.
- `npm run test:management-ui` verifica diferenças entre 0% e ausência de
  dados, contagem de perfis sem responsável ativo, navegação de configurações,
  preservação de handlers e estilos; integrado a `npm test` (25 suítes).
- A CI inclui TypeScript, ESLint, Prettier, builds Web/Extension, 25 suítes,
  auditoria de dependências e Docker nos Node.js 22.18.0 e 24.

## Homologação manual recomendada

Testar no Brave com temas claro e escuro, larguras 1440/1024/768/390 px,
configurações com alterações sem salvar, testes de perfil sem extensão online,
relatórios de período vazio e período com conclusões. Não foi realizado
teste visual interativo no Brave/Facebook nesta PR.

**Próxima etapa (4/4):** revisão transversal de responsividade, estados de
teclado, contraste, tabela e elementos de feedback visual.
