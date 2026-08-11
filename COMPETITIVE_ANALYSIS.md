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

## Roadmap recomendado

### P0 — antes de usar com várias contas

1. **Fila por trabalho e perfil ativo — implementado na versão 0.3.0.** A extensão escolhe o perfil local e recebe apenas `publication_jobs` destinados a ele. Cada cartão carrega `jobId`, `vehicleId` e `accountId`.
2. **Validação pré-publicação — implementada.** `POST /api/publications` recusa o trabalho (422) quando faltam preço, quilometragem, localização, descrição ou fotos, devolve exatamente o que falta e marca o veículo como `Atenção`. O painel mostra a lista de campos pendentes no aviso.
3. **Retorno de execução — implementado na versão 0.3.0.** O trabalho salva quantidade de fotos e campos preenchidos, campos não encontrados, horário e versão da extensão. O ciclo usa `pendente → preenchendo → aguardando confirmação → concluído/erro`.
4. **Saúde dos seletores.** Separar os mapas de campos por idioma, criar testes com páginas simuladas e mostrar um alerta quando o layout do Facebook mudar.
5. **Galeria ordenável — implementada.** `PATCH /api/vehicles/:id/images/reorder` grava a nova ordem; a primeira foto é a capa e o painel tem setas para reordenar cada imagem.

### P1 — operação diária

6. Importação por CSV/planilha e, depois, sincronização com a fonte de estoque da loja.
7. Identificador de estoque/VIN e prevenção de duplicidade por veículo + perfil.
8. Pausa, retomada e repetição manual de trabalhos com erro.
9. Marcar vendido, retirar anúncio e registrar URL final da publicação.
10. Histórico de alterações e auditoria por usuário.

### P2 — diferenciação

11. Modelos de descrição por loja e por tipo de veículo.
12. Decodificação de VIN e preenchimento de opcionais.
13. Sugestões de descrição e qualidade das fotos, sempre com revisão humana.
14. Indicadores por vendedor: tempo até publicar, taxa de preenchimento completo e erros por campo.

## O que não recomendo priorizar

- Clique automático no botão final **Publicar**.
- Importação ou armazenamento de cookies do Facebook.
- Rotação artificial de CEP/localização.
- Publicação em massa em grupos e respostas automáticas sem revisão.

Esses recursos aparecem em algumas extensões comerciais, mas aumentam risco operacional e não resolvem os gargalos principais do produto: qualidade dos dados, atribuição correta da conta e rastreabilidade.

## Fontes

- [MarketSync — Facebook Marketplace Auto-Poster](https://marketsync.link/facebook-marketplace-poster.html)
- [FLUF Connect — extensão e sincronização](https://fluf.io/extension/)
- [AutoPoster — Chrome Web Store](https://chromewebstore.google.com/detail/autoposter/bnjlfphkdfmkgljjknamcakejmeinpcl)
- [Facebook-Marketplace-Auto-Poster — GitHub](https://github.com/aronk254/Facebook-Marketplace-Auto-Poster)
- [FAP Facebook Auto Poster — GitHub](https://github.com/Tigerzplace/FAP-FacebookAutoPoster)
