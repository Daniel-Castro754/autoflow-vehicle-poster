# AutoFlow para Brave — Manifest V2

## Instalação local

1. Inicie o AutoFlow com `npm run dev`.
2. Abra `brave://extensions`.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione esta pasta `extension-mv2`.
6. Abra a extensão, entre com sua conta do AutoFlow e escolha um veículo.

A extensão pede que você selecione o perfil ativo do Brave e mostra somente os trabalhos atribuídos a ele. Ao abrir um trabalho, preenche tipo, fotos, localização, ano, fabricante, modelo, preço, quilometragem, câmbio, combustível, carroceria, cor e descrição. Campos do Marketplace aparecem progressivamente, por isso o preenchimento é sequencial. O resultado de cada campo volta para o painel como **Aguardando confirmação**. A interface do Facebook muda com frequência; revise todos os dados. A extensão nunca clica em **Publicar**, não contorna desafios e não lê nem exporta cookies.

Após atualizar os arquivos, abra `brave://extensions` e clique em **Recarregar** no cartão da extensão AutoFlow.

## Compatibilidade

Manifest V2 tem suporte limitado nas versões atuais do Brave. Se a instalação for recusada, será necessário gerar a variante Manifest V3 usando os mesmos arquivos de popup e conteúdo.
