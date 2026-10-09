# Fase 6 — Design System e reorganização da Visão geral

## Entrega 1 de 4: fundação visual + visão geral

Esta PR mantém o funcionamento das APIs, filas, publicações, login e configurações.
Ela não modifica dados do SQLite, não adiciona migrations nem ativa publicação automática.

### Design System

- Novo `src/design-system.css`, importado **depois** do CSS legado.
- Tokens semânticos para superfícies, texto, bordas, foco, sucesso, alerta e risco.
- Tema claro e tema escuro em grafite, com a assinatura verde AutoFlow.
- Padronização incremental de cartões, navegação, botões, campos, indicadores,
  estados de foco, tipografia e espaçamento.
- Legibilidade revisada nos componentes comuns (subtítulos, totais, cards e menus).
- Melhor comportamento em larguras menores, sem o mínimo global de 1.100 px.
- Respeita `prefers-reduced-motion`.

Ainda restam estilos específicos das páginas legadas com valores fixos: serão
migrados nas próximas entregas. Não é uma reescrita de 5.400 linhas de CSS.

### Visão geral

1. Valor estimado de estoque aparece em um resumo compacto, acompanhado de
   uma barra de progresso acessível para a proporção publicada.
2. KPIs mantidos, com destaque tipográfico padronizado.
3. Novo componente **Ações necessárias** exibe prioridades verificáveis:
   veículos `Atenção`, veículos com **zero fotos** (excluindo vendidos),
   veículos `Pronto` e incidentes operacionais ativos/críticos.
4. O CTA de cada prioridade abre a página correspondente ou expande o monitoramento.
5. **Estoque recente** e **Ações rápidas** sobem na hierarquia.
6. Saúde operacional, Central de intervenções e insights continuam disponíveis
   em **Monitoramento e diagnósticos**. Só são montados ao expandir, reduzindo
   polling e conteúdo inicial.
7. Falha ao carregar dados não aparece como indicadores comprovadamente zerados:
   o valor financeiro exibe marcador pendente e o painel apresenta aviso.
8. O indicador de incidentes é consultado pelo endpoint já autenticado e isolado
   por empresa, a cada 30 segundos. Se a consulta falhar, o aviso permanece visível.

**Limites:** o novo quadro utiliza apenas os estados e a contagem de fotos
retornados pela API. Não adivinha status de conexão com o Facebook nem afirma
que algo foi vendido/publicado com base somente em fotos ou status.
O histórico, filtros e ações da Central de intervenções seguem intactos.

### Validação

- `npm run test:design` valida contagens derivadas, incidentes e presença de
  componentes, tokens de tema, foco e preferência por movimento reduzido.
- CI exige TypeScript, ESLint, Prettier, builds Web/Extension, testes completos,
  npm audit e build Docker nos Node.js 22.18.0 e 24.
- Homologação visual manual sugerida em 1440 px, 1024 px, 768 px e 390 px,
  com tema claro e escuro e o monitoramento expandido/recolhido.

### Próximas entregas (não implementadas nesta PR)

- Etapa 2: Central de IA, Veículos e Publicações.
- Etapa 3: Relatórios, Configurações, Equipe e contas.
- Etapa 4: refinamento responsivo, acessibilidade e inspeção visual completa.
