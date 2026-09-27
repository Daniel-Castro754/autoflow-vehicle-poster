# AutoFlow — comparação funcional e próximos passos

Análise realizada em 9 de agosto de 2026. Os recursos de produtos comerciais abaixo são descrições públicas dos próprios fornecedores; não representam uma auditoria independente do funcionamento interno.

> **Nota de atualização:** este documento preserva pesquisa histórica de agosto de 2026. As afirmações sobre o estado atual do AutoFlow e a lista de lacunas abaixo foram atualizadas; o README descreve os requisitos de runtime e os recursos disponíveis no checkout.

## Resumo executivo

O AutoFlow usa painel de estoque + extensão local no navegador + sessão do Facebook mantida no perfil local. A publicação final é manual por padrão; a organização pode habilitar publicação automática, sujeita aos mesmos gates de prontidão da fila, confirmação de campos e fotos, capacidade e vínculo de execução. Cookies e senhas do Facebook não são enviados ao servidor.

O trabalho atual prioriza integridade operacional: filas e leases por trabalho/perfil/aba/documento, reconciliação de publicação ambígua, limites no momento da execução, retomada segura de uploads e rastreabilidade de resultados. O comportamento da página do Facebook continua dependente do DOM do Marketplace e não foi validado neste ciclo por uma publicação real em sessão autenticada.

## Comparação

| Capacidade                                      | AutoFlow atual                                                                                | Referência pública                                 | Leitura                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Painel + extensão                               | Sim                                                                                           | MarketSync e FLUF                                  | Base correta                                                                                       |
| Sessão local, sem senha do Facebook no servidor | Sim                                                                                           | MarketSync, FLUF e projeto aberto                  | Manter                                                                                             |
| Preenchimento de veículo                        | Preenche campos por rótulos e valida os valores antes de avançar                              | MarketSync                                         | Cobertura real ainda depende de idioma e mudanças no DOM do Marketplace                            |
| Fotos                                           | Até 20 fotos, upload retomável, validação de decodificação e reordenação; a primeira é a capa | MarketSync envia em ordem; FLUF sincroniza edições | Não há seleção de capa separada da ordem                                                           |
| Revisão/publicação final                        | Publicação manual por padrão; automação opcional, desativada por padrão e protegida por gates | MarketSync descreve revisão humana                 | Não tratar publicação automática como garantia de resultado; resultado incerto exige reconciliação |
| Várias contas/perfis                            | Contas vinculadas a usuários e fila filtrada pelo perfil ativo                                | MarketSync usa contas por representante            | A execução também verifica job, lease, aba e documento                                             |
| Estado da publicação                            | Fila, diagnóstico campo a campo, histórico, recuperação e estados de confirmação/remoção      | FLUF descreve edição, remoção e sincronização      | Testes de integração cobrem os contratos locais                                                    |
| Prevenção de duplicidade                        | Bloqueia novos trabalhos incompatíveis e não repete automaticamente publicação ambígua        | AutoPoster anuncia detecção de duplicados          | Verificações locais não substituem reconciliação do anúncio no Facebook                            |
| Operação em lote                                | Agendamento, pausa, retomada, prioridade e filtros da fila; ações de estoque em massa         | FLUF descreve operações em massa                   | A importação por CSV/planilha ainda não está implementada                                          |
| Importação/sincronização de estoque             | Não implementada                                                                              | FLUF e ferramentas de concessionárias              | Continua sendo uma frente futura independente                                                      |
| Observabilidade                                 | Relatórios agregados, ocorrências paginadas, métricas por vendedor/perfil e health monitor    | Projeto FAP expõe progresso, falhas e resumo       | Não há telemetria externa centralizada por padrão                                                  |

## O que o código aberto ensina

O repositório [Facebook-Marketplace-Auto-Poster](https://github.com/aronk254/Facebook-Marketplace-Auto-Poster) usa Go com automação de navegador, percorre diretórios locais de veículos, carrega imagens e abre diretamente a rota de criação de veículo. O código de veículo embaralha a ordem das pastas e executa a postagem por automação de página.

Ele confirma que imagens por pasta e uma sessão local são suficientes para um protótipo, mas não é uma boa base arquitetural para o AutoFlow: não há painel multiempresa, fila persistente por conta, trilha de auditoria ou ciclo claro de recuperação. O AutoFlow já é mais forte nesses fundamentos.

O projeto aberto [FAP](https://github.com/Tigerzplace/FAP-FacebookAutoPoster), embora seja focado em grupos e não em veículos, mostra boas ideias de experiência operacional: progresso visível, pausa/retomada, uma tentativa controlada após falha e resumo final com sucessos e erros. Podemos aproveitar esses padrões sem copiar o comportamento de publicação automática em massa.

## Registro histórico — 11 de agosto de 2026

Segunda rodada de pesquisa, focada em procurar um caminho oficial (API/feed) para o Marketplace orgânico e mapear ferramentas comerciais e projetos abertos. As conclusões abaixo registram o entendimento daquela data; não são aconselhamento jurídico nem confirmação de políticas atuais.

### Integração oficial investigada naquela data

As páginas consultadas então indicavam que a distribuição automática de catálogo de parceiros para o Marketplace havia sido descontinuada em 13/09/2021 e que o Commerce Manager tratava _Automotive Inventory Ads_. Reconfirme a documentação oficial da Meta antes de usar esta observação para decisões de compliance. O AutoFlow mantém a sessão no navegador local e não depende de enviar cookies ao servidor.

### Observações de política registradas naquela data

- A pesquisa citava **10 veículos/dia por conta** como limite; no AutoFlow, 10 é o valor padrão configurável, não um limite imutável imposto pelo código (a tela aceita até 50). Confirme a regra vigente da Meta antes de definir operação.
- A pesquisa recomendava publicar a partir de perfil pessoal. A extensão usa o perfil local do Brave configurado pela organização; a adequação do perfil deve ser verificada com a política vigente.
- A pesquisa citava espaçamento de 5+ minutos. O AutoFlow aplica capacidade e intervalo configurados no momento da execução, mas esses valores são controles operacionais do produto, não uma declaração de conformidade com uma regra atual da Meta.
- A pesquisa citava retirada de veículo vendido em até 24h. O AutoFlow marca a venda, interrompe ou sinaliza trabalhos ativos e destaca anúncios concluídos que aguardam retirada; a remoção efetiva do anúncio no Marketplace ainda depende da ação do usuário.

### Concorrência 2026 (ferramentas novas encontradas nesta rodada)

| Ferramenta                                                                                                                                                                                          | O que faz de diferente                                                                                                                                                 | Vale trazer para o AutoFlow?                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [CARVID](https://www.carvidapp.com/facebook-marketplace-auto-poster/)                                                                                                                               | Cap de 10/dia com intervalo randomizado "mimic human behavior"; remove anúncio vendido em 24h automaticamente via DMS; leaderboard de posts/cliques/leads por vendedor | Sim — pacing randomizado e o gatilho de remoção em 24h                                                                           |
| [Owini](https://owini.ai/post/best-facebook-marketplace-posting-tool)                                                                                                                               | Digitação e cliques com atraso/movimento de mouse simulados; descrição única gerada por IA por anúncio                                                                 | Sim — pacing humano no preenchimento da extensão                                                                                 |
| [ZenLitePro](https://www.zenlitepro.com/)                                                                                                                                                           | 25–40 posts/dia por conta usando ambientes de navegador isolados + **proxies residenciais**                                                                            | **Não** — extrapola o limite oficial de 10/dia e usa rotação de IP, exatamente o padrão que este documento já recomendava evitar |
| Shiftly Auto                                                                                                                                                                                        | Processamento em lote espalhado ao longo de horas                                                                                                                      | Já está no roadmap (P1, item 8)                                                                                                  |
| DealerCenter Auto-Uploader                                                                                                                                                                          | Puxa direto do DMS e roda "como se fosse manual" num PC Windows dedicado                                                                                               | Confirma a demanda por importação de estoque (P1, item 6)                                                                        |
| Bots abertos ([Ezee-Kits](https://github.com/Ezee-Kits/Facebook-Marketplace-Auto-Poster-Bot-Python-Pyppeteer-), [privacyrepo](https://github.com/privacyrepo/facebook-marketplace-autolisting-bot)) | Clicam em "Publicar" sozinhos; vários apagam e republicam o mesmo anúncio para subir no feed; nenhum documenta limite de taxa                                          | **Não copiar** — evitar repetição artificial de anúncios e retries de resultado incerto, seja no modo manual ou automático       |

### Ajustes no roadmap por causa desta pesquisa

- **Pacing humano** foi sugerido porque, naquela versão, a extensão não variava o ritmo de preenchimento. A extensão atual já usa atrasos variáveis entre etapas.
- **Marcar vendido e acompanhar a retirada** passou a ter prioridade operacional; não afirmar compliance automático: a remoção no Marketplace continua manual.
- **Item 6 (importação por CSV) confirmado como o maior ganho de produtividade**: é a funcionalidade nº1 citada por praticamente todo concorrente comercial pesquisado (CARVID, ZenLitePro, Owini, Shiftly, DealerCenter).

## Roadmap histórico recomendado em agosto de 2026

> A lista abaixo é um registro das recomendações originais, não o status atual do produto nem um plano vigente. Parte dos itens foi implementada depois; consulte a seção “Escopo atual” do README para capacidades e limitações do checkout.

### P0 histórico — antes de usar com várias contas

1. **Fila por trabalho e perfil ativo — implementado na versão 0.3.0.** A extensão escolhe o perfil local e recebe apenas `publication_jobs` destinados a ele. Cada cartão carrega `jobId`, `vehicleId` e `accountId`.
2. **Validação pré-publicação — implementada.** `POST /api/publications` recusa o trabalho (422) quando faltam preço, quilometragem, localização, descrição ou fotos, devolve exatamente o que falta e marca o veículo como `Atenção`. O painel mostra a lista de campos pendentes no aviso.
3. **Retorno de execução — implementado na versão 0.3.0.** O trabalho salva quantidade de fotos e campos preenchidos, campos não encontrados, horário e versão da extensão. O ciclo usa `pendente → preenchendo → aguardando confirmação → concluído/erro`.
4. **Saúde dos seletores.** Separar os mapas de campos por idioma, criar testes com páginas simuladas e mostrar um alerta quando o layout do Facebook mudar.
5. **Galeria ordenável — implementada.** `PATCH /api/vehicles/:id/images/reorder` grava a nova ordem; a primeira foto é a capa e o painel tem setas para reordenar cada imagem.
6. **Pacing humano no preenchimento (novo).** Variar o intervalo entre campos e simular digitação em vez de inserir o valor de uma vez, reduzindo o padrão repetitivo que ferramentas comerciais como Owini e CARVID já tratam como requisito básico de segurança de conta.

### P1 histórico — operação diária

7. Importação por CSV/planilha e, depois, sincronização com a fonte de estoque da loja. _(maior alavanca de produtividade segundo todos os concorrentes comerciais pesquisados)_
8. Identificador de estoque/VIN e prevenção de duplicidade por veículo + perfil.
9. Pausa, retomada e repetição manual de trabalhos com erro.
10. **Marcar vendido, retirar anúncio e registrar URL final da publicação.** _(agora é requisito de compliance da Meta — remover em até 24h após a venda — não só organização interna)_
11. Histórico de alterações e auditoria por usuário.

### P2 histórico — diferenciação

12. Modelos de descrição por loja e por tipo de veículo.
13. Decodificação de VIN e preenchimento de opcionais.
14. Sugestões de descrição e qualidade das fotos, sempre com revisão humana.
15. Indicadores por vendedor: tempo até publicar, taxa de preenchimento completo e erros por campo. _(CARVID já expõe isso como leaderboard de posts/cliques/leads por vendedor)_

## O que não recomendo priorizar

- Publicação automática habilitada por padrão. No AutoFlow ela é opcional, desativada por padrão e protegida por verificações de prontidão; publicações com resultado incerto não são repetidas automaticamente.
- Importação ou armazenamento de cookies do Facebook.
- Rotação artificial de CEP/localização.
- Publicação em massa em grupos e respostas automáticas sem revisão.
- Proxies residenciais ou rotação de IP para contornar limites. Não usar essa comparação como afirmação do limite oficial vigente; verifique a política atual da Meta.

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
