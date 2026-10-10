# Segredos de alertas — Telegram e webhooks

As configurações de Telegram e webhook passam a usar o cofre de credenciais do AutoFlow (AES-256-GCM; a chave mestra usa DPAPI CurrentUser no Windows).

## Campos protegidos

- `alert_telegram_token`: token do BotFather, cifrado no banco;
- `alert_telegram_chat_id`: destino Telegram, cifrado no banco;
- `alert_webhook_url`: URL completa do webhook, incluindo seus caminhos e parâmetros secretos, cifrada no banco.

Os três campos **não são devolvidos** pela API `GET /api/settings`, mesmo para administradores. A tela exibe apenas se cada integração está configurada e a origem (`database`, `environment`, `none`).

Ao salvar configurações sem preencher campos de alertas, os valores existentes são preservados. Para substituir, informe o novo valor; para remover, confirme a remoção na interface e **salve** as configurações. Testar um alerta usa apenas os valores já salvos ou os definidos no ambiente, nunca os rascunhos não salvos.

Os valores antigos em texto no banco são cifrados automaticamente na inicialização, após a migração do esquema. A rotina valida os textos já cifrados antes de escrever e executa uma única transação. Não delete `vault-key.json` nem altere `DATA_DIR` tentando recuperar uma chave.

## Envio de alertas e destinos

- A URL deve ser HTTPS com domínio público; `localhost`, IP literal, domínios internos/locais, credenciais embutidas, fragmentos e portas alternativas são bloqueados.
- A integração não segue redirecionamentos HTTP durante a entrega.
- Chamadas ao Telegram e webhooks têm timeout de oito segundos.
- O teste de envio faz a chamada com dados fictícios do AutoFlow; um resultado HTTP 200 da rota indica que o teste foi processado, **não necessariamente que Telegram/webhook receberam a mensagem**. Consulte os campos `telegram` e `webhook` na resposta ou a mensagem na tela.
- A filtragem de URLs é proteção inicial contra SSRF. **Não substitui um firewall de saída nem defesa completa contra DNS rebinding**; recomenda-se restringir o tráfego da aplicação em implantações multiusuário.

## Backup e portabilidade

O backup v2 exige `vault-key.json` sempre que o banco tiver chaves ou destinos de alertas cifrados. A recuperação entre usuários Windows continua usando o [pacote portátil de recuperação](PORTABLE_VAULT_RECOVERY.md). Esse pacote precisa ser criado antes de perder acesso ao usuário original.

**Não coloque** arquivos do cofre, tokens, exportações de recuperação ou backups em repositórios Git.
