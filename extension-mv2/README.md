# AutoFlow para Brave — Manifest V2

## Instalação local

1. Inicie o AutoFlow com `npm run dev`.
2. Abra `brave://extensions`.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione esta pasta `extension-mv2`.
6. Abra a extensão, entre com sua conta do AutoFlow e escolha um veículo.

A extensão pede que você selecione o perfil ativo do Brave e mostra somente os trabalhos atribuídos a ele. Ao abrir um trabalho, preenche os dados e fotos do veículo. Em Configurações, o administrador pode habilitar separadamente o clique em **Avançar**, a seleção de grupos por nome exato e o clique em **Publicar**. A publicação automática fica desligada por padrão e é interrompida se algum campo ou grupo configurado falhar. A extensão não contorna desafios e não lê nem exporta cookies.

Após atualizar os arquivos, abra `brave://extensions` e clique em **Recarregar** no cartão da extensão AutoFlow.

## Compatibilidade

Manifest V2 tem suporte limitado nas versões atuais do Brave. Se a instalação for recusada, será necessário gerar a variante Manifest V3 usando os mesmos arquivos de popup e conteúdo.
