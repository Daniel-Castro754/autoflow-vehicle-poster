# Correções da auditoria — 27/09/2026

Base: `e932fe1` (PR #29 integrada). A publicação automática, o avanço de etapas e o consumo autônomo da fila continuam disponíveis. Nenhuma confirmação manual adicional foi introduzida.

Os exemplos do documento recebido foram validados contra o código. A tabela registra a implementação e as adaptações necessárias; copiar alguns trechos literalmente quebraria senhas existentes, migrations ou o Manifest V3.

| Item | Resultado |
| --- | --- |
| 1 | Scheduler usa fuso IANA explícito (`America/Sao_Paulo` por padrão), aritmética de minutos com virada de dia, atraso mínimo e espaçamento também no fallback. |
| 2 | Histórico agrega em UTC e converte para o mesmo fuso do scheduler. `localtime` sozinho continuaria dependendo da máquina. A contagem diária também usa esse fuso. |
| 3 | FIPE resolve códigos pelo catálogo, normaliza aliases, valida marca/modelo/ano e expira o cache em 30 dias ou na mudança do mês. O código proposto para Renault também estava errado; números fixos foram removidos. |
| 4 | Parser reconhece as marcas/modelos ausentes e prioriza nomes completos, como Corolla Cross. Capacidade já era recalculada após cada INSERT na transação; um teste comprova distribuição 2+2 e saturação, sem uma reserva adicional que contaria duas vezes. |
| 5 | Seleção automática restringe contas a `connected`, inclui o teste de trabalho existente na consulta e aceita timestamps SQL/ISO na recência. |
| 6 | Backoff respeita o teto inclusive com jitter; retry exige predicado explícito. Parâmetros inválidos são rejeitados. |
| 7 | Hash scrypt versionado, verificação legada e atualização no login; imagens servidas por stream com fechamento do descritor; limites de tempo HTTP. |
| 8 | Os seis reparos de dados passam a ser migration 7, transacional e executada uma vez. Checksum e conteúdo das migrations 1–6 permanecem compatíveis, verificados contra fixture extraída da main. |
| 9 | Logs JSON, filtro `LOG_LEVEL`, ocultação de campos sensíveis e tratamento de erros, referências circulares e BigInt. |
| 10 | Telegram usa MarkdownV2 escapado; Telegram e webhook têm timeout de 8 segundos. Testes usam respostas simuladas. |
| 11 | Contexto invalidado interrompe o content script sem apagar estado do worker. Fotos confirmadas não são reenviadas; falhas de download podem ser retomadas na ordem. Upload enviado sem confirmação não é repetido às cegas. Busca de campos limitada ao formulário/main e atividade a cada 15 s. |
| 12 | Fechamento de aba libera sua execução, preservando outbox e evidências de publicação. Um único listener de alarme verifica também se o documento ainda responde após recarga da extensão, sem renovar lease por essa sondagem. Base64 usa chunks; `FileReader` não existe em service workers MV3. A validação restrita das URLs locais foi mantida. |
| 13 | Popup descarta respostas obsoletas de perfis/fila, aguarda content script com prazo, impede aberturas simultâneas, escapa HTML e trata resposta inválida/timeout. Senha limpa após login. |
| 14 | Foco visível, fonte herdada, cores escuras e movimento reduzido no popup. |
| 15 | Ícones PNG reais 16/48/128, versão 0.14.0 e Chromium mínimo 120. |
| 16 | Documento HTML completo em pt-BR, metadados e favicon. |
| 17 | Scripts de typecheck/formatação e novas suítes; ferramentas de build movidas para devDependencies e lockfile atualizado. |
| 18 | TypeScript da interface com verificações de índices, opcionais exatos, imports de tipo e código não usado; erros encontrados corrigidos. |
| 19 | Alias `@`, proxy de uploads, porta fixa, target ES2022 e chunks compatíveis com Vite 8. Sourcemaps ocultos, sem serem servidos pela API. |
| 20 | Exemplo de ambiente com segredos vazios e documentação de origem, fuso, login e logs. |
| 21 | Regras extras de ESLint habilitadas. `eslint-plugin-jsx-a11y@6.10.2` rejeita ESLint 10 nos peers; não foi instalado à força nem mantido um downgrade para ESLint 9 sem suporte. A correção de acessibilidade do HelpTip está aplicada; inclusão do plugin aguarda versão compatível. |
| 22 | CI em Node 22.18 e 24: instalação, tipos, lint, formato, build, testes e auditoria de dependências. Job separado constrói o container. |
| 23 | Docker multi-stage, dependências de produção, usuário sem privilégios, volume de dados e healthcheck. API também serve o painel compilado. |
| 24 | Helper de portas dinâmicas, cliente com vínculo de documento e servidor temporário; suites de fila e segurança reutilizam o cliente. |
| 25 | `referenceDate` correto, colisões determinísticas, versões de migrations atualizadas, comparação de campos independente da ordem e corrida de venda sincronizada pelo HTTP 100-continue. |
| 26 | HelpTip usa botão real, vínculo com tooltip por ID, foco, ativação e Escape. Remover apenas role/tabIndex tornaria a ajuda inacessível ao teclado. |
| 27 | Falhas inesperadas da API registram rota e tipo de erro, sem token, corpo ou query string. |
| 28 | Polling ignora respostas após desmontagem/troca de API e evita requisições periódicas sobrepostas. |
| 29 | Estoque recarrega por revisão explícita após mutações, sem depender da identidade do array de veículos. Arquivos acima de 12 MB são rejeitados antes da leitura base64. |
| 30 | Ranking de trabalhos não carrega o relatório inteiro. Depois do ranking, SQL extrai somente campos usados pelo painel, com tolerância a JSON inválido. |
| 31 | Ocorrências são sempre paginadas: padrão 50, teto 100, cursor validado. Teste cobre 51 eventos sem repetição. |
| 32 | Migration 8 adiciona índices de prioridade/conta/veículo, timeline e limpeza de sessões. Os índices de sessão correspondem às expressões realmente consultadas, comprovados por EXPLAIN. |
| 33 | FKs restritivas preservadas. CASCADE geral permitiria excluir anúncios/histórico sem as proteções das rotas e não corrigiria automaticamente bancos existentes. Teste confirma rejeição de exclusão e ausência de órfãos. WAL verificado, demais PRAGMAs preservados. |
| 34 | Limpeza de sessões expiradas/revogadas usa os novos índices, com teste de exclusão e isolamento entre sessões. |
| 35 | Nova suíte FIPE: cache, mês/TTL, aliases, marcas distintas, divergências e indisponibilidade. |
| 36 | Nova suíte timezone: três fusos do host, histórico noturno, limites de minuto/dia e colisão no fallback. |
| 37 | Nova suíte de sessões: hash legado, upgrade, expiração, revogação, limpeza e HTTP. |
| 38 | Gitignore cobre dados, backups, ambientes, logs e cobertura, preservando `.env.example`. |
| 39 | Licença MIT solicitada adicionada. |
| 40 | EditorConfig adicionado. |
| 41 | Prettier configurado; normalização de formato separada das alterações funcionais no histórico de commits. |
| 42 | `.nvmrc` usa Node 24 LTS; mínimo compatível 22.18. Node 22.13 não executa os arquivos TS sem a flag experimental que os scripts atuais não usam. |

## Verificação

- Onze suítes: estoque, fila, automação, consumidor da extensão, backup, segurança de publicação, serviços auditados, FIPE, fuso, sessões e resiliência do content script.
- Testes bloqueiam HTTP externo e removem credenciais de IA/alertas herdadas. Nenhuma publicação ou mensagem externa é usada como teste.
- Typecheck, lint, build, formatação, sintaxe dos scripts da extensão e auditoria de dependências.
- A interação real com Facebook/Brave continua exigindo homologação no navegador. Docker não está disponível no ambiente local; a construção do container está coberta pelo job de CI adicionado.

Referências técnicas utilizadas: [Node TypeScript](https://nodejs.org/download/release/v22.21.0/docs/api/typescript.html), [scrypt/OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) e [API FIPE v1](https://deividfortuna.github.io/fipe/).
