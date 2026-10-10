# Grupos Marketplace por CSV — primeira etapa

Esta branch implementa importação de grupos pelo painel **Configurações → Marketplace → Gerenciador de grupos → Importar CSV**, com limite de 2.000 grupos cadastrados e seleção de até 20 ativos para cada anúncio.

## Formato do CSV

Use UTF-8, separador ponto e vírgula, com cabeçalho:

```csv
nome;url;cidade;uf;membros;privacidade;ativo
Carros e Motos - Criciúma e Região;https://www.facebook.com/groups/123456;Criciúma;SC;36600;Privado;Sim
Mercado Livre Jaguaruna e Região;https://www.facebook.com/groups/654321;Jaguaruna;SC;21600;Público;Sim
```

O nome é obrigatório; a URL pode ficar vazia, mas uma URL informada precisa pertencer a `facebook.com/groups/`. Sem URL, dois grupos com nomes iguais podem ser confundidos. O arquivo aceita apenas valores simples; campos com separadores entre aspas ainda não são suportados. Após carregar, **salve as configurações** para persistir.

## Critérios e atualização

A cidade base é sempre a **Localização padrão** da empresa nas configurações. A pontuação combina sucesso histórico, tamanho do grupo em escala logarítmica e correspondência da cidade/UF. Não há geocodificação nem distância rodoviária: a comparação é por cidade e estado declarados.

Com **Curadoria inteligente de grupos** ativada, o serviço reavalia a classificação após cada lote de 10 publicações com status confirmado como concluído; verificação a cada minuto. É possível reordenar manualmente pelo botão já existente.

**Importante:** o processo NÃO consulta nem extrai automaticamente o número de membros do Facebook. A contagem permanece como foi informada no CSV. A captura por extensão requer desenvolvimento e validação adicionais antes de ser habilitada; o reprocessamento automático a cada dez postagens apenas recalcula a posição dos dados disponíveis.

## Validação antes do merge

- Criar backup do banco;
- Rodar `npm run typecheck`, `npm run lint`, `npm run build` e `npm test`;
- Importar, salvar, recarregar e verificar grupos com e sem URL;
- Validar separação por organização e seleção máxima de 20 grupos;
- Simular 10 publicações confirmadas e verificar atualização do ranking sem publicar de verdade;
- Confirmar a migração de dados e restauração do backup.
