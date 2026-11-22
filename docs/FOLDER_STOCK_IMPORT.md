# Importar pasta de estoque (CSV + fotos, sem montar ZIP)

O AutoFlow aceita seleção de **pasta local** pelo Brave/Chromium. O navegador lê
os arquivos que o operador escolher e monta, em memória, um ZIP compatível com
a importação existente. Não há sincronização da pasta em segundo plano, acesso
permanente ao disco ou upload antes da seleção explícita.

## Exemplo 1: CSV e fotos por identificador no nome

```text
MeuEstoque/
├── veiculos.csv
├── SAVEIRO-19__01.jpg
├── SAVEIRO-19__02.jpg
└── FASTBACK-24__01.jpg
```

## Exemplo 2: fotos por pasta

```text
MeuEstoque/
├── veiculos.csv
└── fotos/
    ├── SAVEIRO-19/
    │   ├── 01.jpg
    │   └── 02.png
    └── FASTBACK-24/
        └── frontal.webp
```

Também é aceito `fotos/SAVEIRO-19__01.jpg` (sem pasta por carro).
A coluna **Estoque** do CSV deve corresponder exatamente ao identificador
nos nomes/pastas, sem diferenciar maiúsculas e minúsculas. Não há correspondência
por modelo, placa, VIN aproximado ou descrição, para evitar fotos no veículo
errado. Não coloque códigos de estoque com barras em nomes de pasta.

Use CSV UTF-8 com campos já suportados pelo importador; o arquivo de exemplo
está em [Importação ZIP](VEHICLE_ZIP_IMPORT.md).

## Passos

1. No painel **Veículos**, escolha **Importar pasta** e selecione `MeuEstoque`.
2. Informe se deseja **Atualizar existentes** ou **Somente novos**.
3. O navegador converte a pasta em ZIP localmente e chama apenas a prévia
   `POST /api/vehicles/import`, com `dryRun: true`.
4. Revise o número de novos, atualizações, fotos, códigos de estoque e erros.
   **Nada é gravado ainda**.
5. Clique **Confirmar importação** para submeter o ZIP original com o
   `previewDigest`. O servidor rejeita mudanças no estoque desde a prévia,
   fotos inválidas, códigos sem correspondência e atualizações bloqueadas.

Limites herdados: ZIP até 48 MB, um CSV na raiz de até 2 MB, até 100 veículos,
até 200 imagens JPG/PNG/WebP, no máximo 20 por veículo e 12 MB por imagem.
Um arquivo inesperado causa erro explícito; não é descartado silenciosamente.
As fotos são anexadas sem duplicar conteúdo e sem substituir a galeria existente.

A importação **não cria trabalhos na fila e não publica no Facebook**.
Use o comando independente **Adicionar à fila** somente após revisar o estoque.

## Limitações

- A seleção de pasta exige Brave/Chromium com o seletor de diretório
  `webkitdirectory`. O arquivo completo é enviado ao servidor local
  `localhost:3333` apenas durante a prévia e a confirmação.
- Em CSV com colunas `image_1` … `image_20`, os caminhos devem seguir
  o layout final `fotos/CODIGO/arquivo.jpg`. Se escolher fotos nomeadas
  `CODIGO__01.jpg`, prefira remover essas colunas e deixar a associação
  automática por código.
- Arquivos desconhecidos, subpastas fora de `fotos/`, códigos duplicados
  e fotos cujo código não exista no CSV são recusados.
- A operação é **assistida**, não uma sincronização diária de ERP/DMS. Uma
  futura integração recorrente exige definir a fonte autoritativa,
  credenciais restritas, revisão de mudanças e política para veículos vendidos.
- O sistema não deve ser utilizado para mudar veículos com trabalhos ativos
  sem conciliação dos anúncios; essa proteção já existe no importador.
