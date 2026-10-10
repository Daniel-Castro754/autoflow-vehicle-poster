# Importação de veículos com fotos (ZIP)

O AutoFlow mantém o importador tradicional de CSV e passa a aceitar um pacote
`.zip` com **um CSV na raiz e fotos organizadas por código de estoque**.

## Estrutura do ZIP

```text
importacao.zip
├── veiculos.csv
└── fotos/
    ├── SAVEIRO-19/
    │   ├── 01.jpg
    │   └── 02.png
    └── FASTBACK-24/
        ├── 01.jpg
        └── 02.webp
```

Exemplo de colunas aceitas no CSV (UTF-8, separadas por ponto e vírgula):

```csv
Estoque;Ano;Marca;Modelo;Versão;Preço;KM;TipoVeiculo;Localização;Câmbio;Combustível;Carroceria;CorExterna;CorInterna;Condição;Status;Descrição
SAVEIRO-19;2019;Volkswagen;Saveiro;Trendline 1.6;60900;80000;Carro/picape;Criciúma - SC;Manual;Flex;Picape;Prateado;Preto;Bom;Rascunho;"Picape 2019; manual e revisada"
FASTBACK-24;2024;Fiat;Fastback;Turbo 200 AT;99900;35000;Carro/picape;Criciúma - SC;Automático;Flex;SUV;Cinza;Preto;Bom;Rascunho;Único dono
```

A pasta depois de `fotos/` deve corresponder exatamente ao identificador da
coluna **Estoque** (comparação sem diferenciar maiúsculas/minúsculas).
Fotos são associadas automaticamente a esse estoque, independentemente da
ordem das imagens. Também é possível indicar caminhos explícitos nas colunas
`image_1` … `image_20` apontando para os arquivos dentro de `fotos/`.
Não utilize caminhos absolutos do Windows nem links da internet nessas colunas.

Formatos: JPG, PNG ou WebP; até **20 fotos por veículo**.
Limites de segurança: arquivo ZIP até **48 MB**, até **100 veículos**, até
**200 fotos** e até **12 MB por imagem**. O conteúdo expandido e o número de
entradas ZIP também têm limite.

## Como importar

1. Na tela **Veículos**, clique em **Importar CSV ou ZIP**.
2. Selecione o arquivo `.zip` e escolha **Atualizar** ou **Somente novos**.
3. Aguarde a prévia: veículos novos, atualizações, fotos associadas e linhas
   com erros. **Nenhum dado é gravado nesse momento**.
4. Revise os dados; clique em **Confirmar importação**.
5. Abra um veículo importado e confira a descrição e a galeria de fotos.
   O AutoFlow não publica anúncios por causa de uma importação.

## Segurança e reimportação

- O ZIP é validado no servidor: central directory, entradas duplicadas,
  traversal, criptografia, formato, integridade CRC, expansão e tamanho.
  Somente fotos completas e decodificáveis são aceitas.
- A prévia inclui um hash do ZIP e um snapshot do estoque e das imagens.
  Se os dados mudarem entre prévia e confirmação, a operação retorna **409**
  e exige uma nova prévia.
- Os arquivos são gravados com nomes aleatórios dentro da pasta de uploads.
  O vínculo com fotos usa sempre a organização autenticada.
- IDs/VIN duplicados continuam seguindo as regras já existentes:
  somente novos ignoram os já cadastrados; atualização não pode sobrescrever
  veículo vendido/publicado ou com publicação ativa. Requer permissão de edição.
- Fotos já cadastradas com o mesmo conteúdo (SHA-256) não são duplicadas;
  na atualização, as demais são anexadas à galeria existente sem substituí-la.
- A importação usa transação SQLite. Se algum arquivo falhar durante a gravação,
  a transação é revertida e os novos arquivos já escritos são removidos.
- Pacotes inconsistentes (imagens sem estoque, arquivos inválidos, ZIP
  corrompido) são recusados antes da transação.
- O importador CSV anterior continua funcionando, sem obrigação de enviar fotos.

## Checklist de homologação manual

- Importar pacote de teste com Saveiro e Fastback: 2 linhas + fotos em pastas
  separadas; validar cada galeria.
- Reimportar em modo **Somente novos**: nada duplicado.
- Reimportar em modo **Atualizar**: preservação das fotos já cadastradas.
- Trocar o CSV ou uma imagem entre a prévia e a confirmação: bloqueio por hash.
- Remover um arquivo referido, tentar path com `../`, imagem corrompida,
  ou pacote acima do limite: erro amigável, sem importação parcial.
- Confirmar que os veículos permanecem Rascunho, sem novos trabalhos em
  Publicações. Nenhum teste deve fazer publicações reais no Facebook.
