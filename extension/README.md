# AutoFlow para Brave — Manifest V3

## Instalação local

1. Inicie o AutoFlow com `npm run dev`.
2. Abra `brave://extensions`.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione esta pasta `extension-mv2`.
6. Abra a extensão, entre com sua conta do AutoFlow e escolha um veículo.

A extensão pede que você selecione o perfil ativo do Brave e mostra somente os trabalhos atribuídos a ele. Ao abrir um trabalho, reserva o item exclusivamente para aquela execução, renova a reserva enquanto estiver ativa e bloqueia uma segunda aba para evitar preenchimentos duplicados. Se a aba ou o Brave fechar, a reserva expira automaticamente e o trabalho pode ser retomado. Em seguida, preenche os dados e fotos do veículo. O preenchimento confirma os valores aceitos pelos componentes do Facebook e repete campos problemáticos. Quando **Avançar** está habilitado, a extensão tenta mudar de etapa mesmo que o diagnóstico interno não reconheça algum valor; se o Facebook recusar, executa ciclos de correção e tenta novamente. Em Configurações, o administrador também pode habilitar a seleção de grupos e o clique em **Publicar**. Para tornar os grupos resistentes a mudanças de nome, prefira `Nome do grupo | URL do grupo`; a extensão usa primeiro o ID da URL e mantém o nome como alternativa. Cada mudança de etapa e cada seleção são confirmadas no DOM antes de continuar. A publicação automática fica desligada por padrão e é interrompida quando grupos ou mudança de tela não são confirmados. O botão **Publicar** é acionado uma única vez; se o Facebook não confirmar o resultado, o trabalho fica bloqueado até o operador verificar **Seus classificados** e confirmar no painel que o anúncio não foi criado. O servidor também bloqueia trabalhos simultâneos para o mesmo veículo e reconhece fotos idênticas já usadas em outro anúncio ativo. A extensão não contorna desafios e não lê nem exporta cookies.

Após atualizar os arquivos, abra `brave://extensions` e clique em **Recarregar** no cartão da extensão AutoFlow.

## Compatibilidade

A extensão usa um service worker do Manifest V3. O heartbeat da reserva é reativado por `chrome.alarms` mesmo depois que o navegador suspende o worker, e também é reconfigurado ao instalar ou iniciar o Brave.
