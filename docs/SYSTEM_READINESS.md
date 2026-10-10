# Painel Saúde e Autonomia do AutoFlow

A área **Saúde e autonomia** reúne, em uma única tela, os sinais de configuração e prontidão do programa. Somente **administradores da empresa** podem visualizá-la.

## Fontes e limites

O endpoint autenticado `GET /api/health/readiness` consulta apenas registros locais da organização. Não executa ações externas nem verifica diretamente Google, Facebook, Gemini, OpenAI, Telegram ou serviços de webhook. Não dispara testes, não agenda trabalhos, não edita grupos e não altera o SQLite.

Os estados são:

- **Configurado / condições básicas:** configuração ou pré-condição local encontrada; **não significa conexão testada nem autorização para publicar**.
- **Precisa de atenção:** falta um requisito básico para a configuração ativa, existe pausa ou há incidentes relevantes.
- **Desativado ou aguardando:** recurso opcional desligado ou sem veículos candidatos.
- **Não verificado:** dados que o sistema não tem como confirmar em uma leitura simples (por exemplo, teste real de restauração de backup).

## Indicadores

**Segurança:** existência de segredos legados não cifrados no SQLite; backup e restauração classificados como não verificados. O cofre é inicializado no boot, mas este painel não substitui uma auditoria criptográfica.

**Integrações:** preferência de IA, presença das chaves do provedor selecionado, fallback offline, token e destino do Telegram, webhook configurado. Nenhum valor das chaves, token, chat ID ou URL de webhook é transmitido à interface.

**Autonomia:** quantidade de perfis com sinal recente da extensão, perfis pausados, grupos ativos, veículos `Pronto` com foto e sem trabalho aberto/concluído, agenda recorrente habilitada, trabalhos travados e aguardando confirmação. São apenas **filtros iniciais**: validação de anúncios, disponibilidade do Facebook e aprovação humana continuam indispensáveis onde exigidas.

O painel atualiza a cada 60 segundos enquanto estiver aberto e possui atualização manual. Não armazena histórico adicional, nem altera as regras de publicação.

## Segurança e testes

- Isolamento estrito por `organization_id`, extraído da sessão autenticada; parâmetros de outra organização não alteram o escopo.
- Acesso negado a vendedores no endpoint agregado de segurança.
- `Cache-Control: no-store` nas respostas.
- `npm run test:readiness` valida autorização, ausência de chaves na resposta, isolamento por empresa e inexistência de escrita nas tabelas consultadas.

## Correção adicional do monitor

O monitor de travamentos usa `getAlertCredentials()` antes de enviar notificações; isso corrige o caminho legado que lia os valores criptografados do banco como se ainda fossem tokens em texto.

Esse ajuste não muda o comportamento de recuperação, pausa e confirmação dos jobs.
