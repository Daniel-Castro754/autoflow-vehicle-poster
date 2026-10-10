# Importação de fotos junto ao estoque CSV

O AutoFlow importa dados por **Importar CSV** e fotos por **Importar fotos**, na mesma tela de Veículos. A segunda etapa associa automaticamente cada imagem ao veículo pelo **código de estoque** (coluna `Estoque` ou `stockCode` do CSV).

## Passos

1. No CSV, preencha a coluna `Estoque` com identificadores únicos (ex.: `SAVEIRO01` e `FASTBACK01`).
2. Clique em **Importar CSV** e confirme a prévia. Veículos com erro não serão criados.
3. Organize as imagens usando `CODIGO__NN.ext`, por exemplo:
   - `SAVEIRO01__01.jpg`, `SAVEIRO01__02.jpg`
   - `FASTBACK01__01.jpg`, `FASTBACK01__02.png`
4. Clique **Importar fotos**, selecione múltiplas imagens (pode misturar veículos) e confirme o resumo.

Os sufixos numéricos determinam a ordem de importação. A primeira foto de um veículo sem fotos anteriores é sua capa. O programa respeita o limite de 20 imagens por veículo e mantém as já cadastradas.

## Limitações e segurança

- O CSV **não transporta binários de imagem**. As fotos devem ser escolhidas localmente na segunda etapa.
- Os nomes dos arquivos precisam corresponder exatamente ao código de estoque, sem diferença de letras maiúsculas/minúsculas.
- Apenas JPG, PNG e WebP são aceitos; cada foto pode ter no máximo 12 MB e passa pela validação do backend.
- Imagens idênticas já existentes não são duplicadas.
- Códigos inexistentes são ignorados, e falhas de upload são contabilizadas.
- O envio não cria anúncios nem aciona publicação automática.
- A importação de fotos não é uma operação atômica: se houver falha no meio, as imagens já transferidas permanecem. É possível selecionar novamente os arquivos; a API detecta duplicatas.
