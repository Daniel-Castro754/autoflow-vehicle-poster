# AutoFlow — comparação funcional e próximos passos

Análise realizada em 9 de agosto de 2026. Os recursos de produtos comerciais abaixo são descrições públicas dos próprios fornecedores; não representam uma auditoria independente do funcionamento interno.

## Resumo executivo

O AutoFlow já segue a arquitetura mais adequada para este caso: painel de estoque + extensão no navegador + sessão do Facebook mantida no perfil local + revisão humana antes da publicação. Esse fluxo é semelhante ao descrito pelo MarketSync e evita centralizar cookies ou senhas.

O maior ponto que ainda falta não é “mais automação”: é fechar o ciclo operacional. Hoje a extensão preenche os campos, mas a fila ainda não está realmente isolada por trabalho e perfil, não registra o resultado campo a campo no servidor e não possui uma validação obrigatória antes de abrir o Facebook.

## Comparação

| Capacidade | AutoFlow atual | Referência pública | Leitura |
|---|---|---|---|
| Painel + extensão | Sim | MarketSync e FLUF | Base correta |
| Sessão local, sem senha do Facebook no servidor | Sim | MarketSync, FLUF e projeto aberto | Manter |
| Preenchimento completo de veículo | Sim, com busca tolerante por rótulos | MarketSync | Precisa de testes de compatibilidade por idioma/layout |
| Fotos | Upload e envio de até 20 | MarketSync envia em ordem; FLUF sincroniza edições | Falta reordenar, escolher capa e validar falhas individuais |
| Revisão e clique final humano | Sim | MarketSync descreve o mesmo fluxo | Manter como padrão obrigatório |
| Várias contas/perfis | Modelo de dados existe | MarketSync usa contas por representante | Falta vincular a extensão ao perfil ativo e filtrar a fila por trabalho/perfil |
| Estado da publicação | Fila e alteração manual | FLUF descreve edição, remoção e sincronização | Falta retorno automático de “preenchido”, “aguardando confirmação”, “confirmado” e “erro” |
| Prevenção de duplicidade | Impede dois trabalhos pendentes do mesmo veículo | AutoPoster anuncia detecção de duplicados | Deve considerar veículo + perfil + anúncio confirmado |
| Operação em lote | Seleção/exclusão no estoque | FLUF descreve operações em massa | Falta lote na fila com progresso, pausa e retomada |
| Importação/sincronização de estoque | Não | FLUF e ferramentas de concessionárias | Próxima grande alavanca de produtividade |
| Observabilidade | Resumo local 13/13 na página | Projeto FAP expõe progresso, falhas e resumo | Falta persistir diagnóstico no painel |

## O que o código aberto ensina

O repositório [Facebook-Marketplace-Auto-Poster](https://github.com/aronk254/Facebook-Marketplace-Auto-Poster) usa Go com automação de navegador, percorre diretórios locais de veículos, carrega imagens e abre diretamente a rota de criação de veículo. O código de veículo embaralha a ordem das pastas e executa a postagem por automação de página.

Ele confirma que imagens por pasta e uma sessão local são suficientes para um protótipo, mas não é uma boa base arquitetural para o AutoFlow: não há painel multiempresa, fila persistente por conta, trilha de auditoria ou ciclo claro de recuperação. O AutoFlow já é mais forte nesses fundamentos.

O projeto aberto [FAP](https://github.com/Tigerzplace/FAP-FacebookAutoPoster), embora seja focado em grupos e não em veículos, mostra boas ideias de experiência operacional: progresso visível, pausa/retomada, uma tentativa controlada após falha e resumo final com sucessos e erros. Podemos aproveitar esses padrões sem copiar o comportamento de publicação automática em massa.

## Atualização — 11 de agosto de 2026

Segunda rodada de pesquisa, focada em confirmar se existe um caminho oficial (API/feed) para o Marketplace orgânico e em mapear ferramentas comerciais e projetos abertos que surgiram desde a análise de 9 de agosto.

### Não existe atalho oficial — a arquitetura atual continua sendo a certa

A distribuição automática de catálogo de parceiros de estoque para o Marketplace foi **descontinuada pela Meta em 13/09/2021**. O Commerce Manager de hoje só alimenta *Automotive Inventory Ads* (anúncios pagos), não o anúncio orgânico e gratuito que o AutoFlow produz. Ou seja: não existe uma API legítima para substituir a extensão por postagem em lote no servidor — painel + extensão local + revisão humana continua sendo a abordagem correta, não uma limitação temporária.

### Regras oficiais da Meta que validam (e ajustam) decisões já tomadas

- **10 veículos/dia por conta** é um limite oficial, não uma prática de mercado — o `dailyLimit` padrão do AutoFlow (10) já está calibrado corretamente.
- **Postar a partir de conta pessoal, não Página** — o modelo de perfil local do Brave por vendedor já segue essa regra.
- **Espaçar publicações em 5+ minutos** — hoje isso só acontece "de graça" porque cada trabalho exige abrir uma aba e revisar manualmente; não há nada que impeça um vendedor de dar oito cliques seguidos em "Abrir e preencher" em minutos.
- **Remover veículo vendido em até 24h** — regra oficial, e o AutoFlow **não tem esse fluxo hoje**. Deixa de ser produtividade (item 9 do roadmap) e passa a ser risco de penalização de conta.

### Concorrência 2026 (ferramentas novas encontradas nesta rodada)

| Ferramenta | O que faz de diferente | Vale trazer para o AutoFlow? |
|---|---|---|
| [CARVID](https://www.carvidapp.com/facebook-marketplace-auto-poster/) | Cap de 10/dia com intervalo randomizado "mimic human behavior"; remove anúncio vendido em 24h automaticamente via DMS; leaderboard de posts/cliques/leads por vendedor | Sim — pacing randomizado e o gatilho de remoção em 24h |
| [Owini](https://owini.ai/post/best-facebook-marketplace-posting-tool) | Digitação e cliques com atraso/movimento de mouse simulados; descrição única gerada por IA por anúncio | Sim — pacing humano no preenchimento da extensão |
| [ZenLitePro](https://www.zenlitepro.com/) | 25–40 posts/dia por conta usando ambientes de navegador isolados + **proxies residenciais** | **Não** — extrapola o limite oficial de 10/dia e usa rotação de IP, exatamente o padrão que este documento já recomendava evitar |
| Shiftly Auto | Processamento em lote espalhado ao longo de horas | Já está no roadmap (P1, item 8) |
| DealerCenter Auto-Uploader | Puxa direto do DMS e roda "como se fosse manual" num PC Windows dedicado | Confirma a demanda por importação de estoque (P1, item 6) |
| Bots abertos ([Ezee-Kits](https://github.com/Ezee-Kits/Facebook-Marketplace-Auto-Poster-Bot-Python-Pyppeteer-), [privacyrepo](https://github.com/privacyrepo/facebook-marketplace-autolisting-bot)) | Clicam em "Publicar" sozinhos; vários apagam e republicam o mesmo anúncio para subir no feed; nenhum documenta limite de taxa | **Não copiar** — é exatamente o padrão de risco que o clique manual obrigatório do AutoFlow evita de propósito |

### Ajustes no roadmap por causa desta pesquisa

- **Novo item de P0**: pacing humano na extensão (`content.js` hoje preenche campos instantaneamente, com apenas pausas fixas de espera por elemento — sem variação nem simulação de digitação).
- **Item 9 (marcar vendido) sobe de prioridade**: não é mais só "fechar o ciclo", é compliance com a política da Meta.
- **Item 6 (importação por CSV) confirmado como o maior ganho de produtividade**: é a funcionalidade nº1 citada por praticamente todo concorrente comercial pesquisado (CARVID, ZenLitePro, Owini, Shiftly, DealerCenter).

## Roadmap recomendado

### P0 — antes de usar com várias contas

1. **Fila por trabalho e perfil ativo — implementado na versão 0.3.0.** A extensão escolhe o perfil local e recebe apenas `publication_jobs` destinados a ele. Cada cartão carrega `jobId`, `vehicleId` e `accountId`.
2. **Validação pré-publicação — implementada.** `POST /api/publications` recusa o trabalho (422) quando faltam preço, quilometragem, localização, descrição ou fotos, devolve exatamente o que falta e marca o veículo como `Atenção`. O painel mostra a lista de campos pendentes no aviso.
3. **Retorno de execução — implementado na versão 0.3.0.** O trabalho salva quantidade de fotos e campos preenchidos, campos não encontrados, horário e versão da extensão. O ciclo usa `pendente → preenchendo → aguardando confirmação → concluído/erro`.
4. **Saúde dos seletores.** Separar os mapas de campos por idioma, criar testes com páginas simuladas e mostrar um alerta quando o layout do Facebook mudar.
5. **Galeria ordenável — implementada.** `PATCH /api/vehicles/:id/images/reorder` grava a nova ordem; a primeira foto é a capa e o painel tem setas para reordenar cada imagem.
6. **Pacing humano no preenchimento (novo).** Variar o intervalo entre campos e simular digitação em vez de inserir o valor de uma vez, reduzindo o padrão repetitivo que ferramentas comerciais como Owini e CARVID já tratam como requisito básico de segurança de conta.

### P1 — operação diária

7. Importação por CSV/planilha e, depois, sincronização com a fonte de estoque da loja. *(maior alavanca de produtividade segundo todos os concorrentes comerciais pesquisados)*
8. Identificador de estoque/VIN e prevenção de duplicidade por veículo + perfil.
9. Pausa, retomada e repetição manual de trabalhos com erro.
10. **Marcar vendido, retirar anúncio e registrar URL final da publicação.** *(agora é requisito de compliance da Meta — remover em até 24h após a venda — não só organização interna)*
11. Histórico de alterações e auditoria por usuário.

### P2 — diferenciação

12. Modelos de descrição por loja e por tipo de veículo.
13. Decodificação de VIN e preenchimento de opcionais.
14. Sugestões de descrição e qualidade das fotos, sempre com revisão humana.
15. Indicadores por vendedor: tempo até publicar, taxa de preenchimento completo e erros por campo. *(CARVID já expõe isso como leaderboard de posts/cliques/leads por vendedor)*

## O que não recomendo priorizar

- Clique automático no botão final **Publicar**.
- Importação ou armazenamento de cookies do Facebook.
- Rotação artificial de CEP/localização.
- Publicação em massa em grupos e respostas automáticas sem revisão.
- Proxies residenciais ou navegadores isolados por conta para postar acima do limite oficial de 10/dia (abordagem do ZenLitePro) — extrapola a política da Meta em vez de trabalhar dentro dela.

Esses recursos aparecem em algumas extensões comerciais, mas aumentam risco operacional e não resolvem os gargalos principais do produto: qualidade dos dados, atribuição correta da conta e rastreabilidade.

## Fontes

- [MarketSync — Facebook Marketplace Auto-Poster](https://marketsync.link/facebook-marketplace-poster.html)
- [FLUF Connect — extensão e sincronização](https://fluf.io/extension/)
- [AutoPoster — Chrome Web Store](https://chromewebstore.google.com/detail/autoposter/bnjlfphkdfmkgljjknamcakejmeinpcl)
- [Facebook-Marketplace-Auto-Poster — GitHub](https://github.com/aronk254/Facebook-Marketplace-Auto-Poster)
- [FAP Facebook Auto Poster — GitHub](https://github.com/Tigerzplace/FAP-FacebookAutoPoster)

### Fontes da atualização de 11 de agosto de 2026

- [Meta — Sobre o estoque de concessionárias no Marketplace](https://en-gb.facebook.com/business/help/562933087372962)
- [Meta — Configurar catálogo para Automotive Inventory Ads](https://www.facebook.com/business/help/143781049600895)
- [Best Facebook Marketplace Posting Tools for Dealers (2026) — Owini](https://owini.ai/post/best-facebook-marketplace-posting-tool)
- [CARVID — Facebook Marketplace Auto Poster](https://www.carvidapp.com/facebook-marketplace-auto-poster/)
- [ZenLitePro](https://www.zenlitepro.com/)
- [DealerCenter — Facebook Marketplace Auto-Uploader](https://support.dealercenter.net/hc/en-us/articles/12435635095956-How-to-Use-the-Facebook-Marketplace-Auto-Uploader)
- [Shiftly Auto — How Many Cars Can You Post on Facebook Marketplace Per Day?](https://shiftlyauto.com/blogs/how-many-cars-can-you-post-on-facebook-marketplace-per-day)
- [Ezee-Kits — Facebook Marketplace Auto Poster Bot (Python/Pyppeteer)](https://github.com/Ezee-Kits/Facebook-Marketplace-Auto-Poster-Bot-Python-Pyppeteer-)
- [privacyrepo — facebook-marketplace-autolisting-bot](https://github.com/privacyrepo/facebook-marketplace-autolisting-bot)
