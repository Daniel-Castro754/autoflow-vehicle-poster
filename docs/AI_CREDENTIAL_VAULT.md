# Cofre de credenciais de IA (AutoFlow)

O AutoFlow cifra as chaves Gemini e OpenAI no SQLite com **AES-256-GCM**. Os textos sem criptografia em instalações anteriores são migrados automaticamente na primeira inicialização desta versão, dentro de uma transação. Os dados **não são enviados ao navegador**.

### Windows

A chave mestra AES-256 é um valor aleatório protegido com o **DPAPI CurrentUser** do Windows. O arquivo `<DATA_DIR>/vault-key.json` contém apenas a chave mestra encapsulada pelo DPAPI; não contém as chaves Gemini/OpenAI legíveis. O Windows deve executar a aplicação sob **o mesmo usuário** que criou o cofre, inclusive nas reinicializações e tarefas agendadas.

Se o arquivo ou o perfil Windows original for perdido, o AutoFlow **não conseguirá abrir as chaves cifradas**. Não tente gerar novo cofre nem restaurar apenas o `autoflow.db`; mantenha o arquivo de cofre e o backup completo. A aplicação falha explicitamente ao não conseguir descriptografar.

### Linux / CI

Usa AES-256-GCM com chave derivada via scrypt de `AUTOFLOW_VAULT_KEY` (recomendado, mínimo 32 caracteres) ou `AUTH_SECRET` (padrão, mínimo 32 caracteres), mais salt aleatório em `vault-key.json`. Guardar o segredo da configuração em local separado dos backups. Trocar `AUTH_SECRET` sem manter o segredo original impossibilita recuperar as credenciais, a menos que `AUTOFLOW_VAULT_KEY` tenha sido fixado antes.

### Backup / restauração

`npm run backup -- create .\backups` salva o banco, uploads e o arquivo `vault-key.json` (quando existente), com hashes SHA-256. `verify` valida a integridade; `restore` restaura os arquivos. O formato v2 mantém leitura de backups legados v1. Uma cópia contendo credenciais cifradas sem o cofre é recusada.

**Importante:** o cofre DPAPI só funciona no perfil Windows que o criou. Para trocar de computador/usuário, use a instalação original para cadastrar as mesmas chaves em um novo perfil após restaurar o restante do banco (ou implemente uma rotina de exportação protegida com senha de recuperação antes de migrar). O comando de backup verifica integridade e não garante portabilidade das chaves. Backups podem conter outros dados sensíveis, como veículos e tokens de alertas, que ainda exigem proteção de acesso.

### Fallback da IA

- `auto`: Gemini → OpenAI → descrição procedural offline, conforme as chaves disponíveis;
- `gemini` ou `openai`: só tenta o provedor escolhido e, se falhar, usa o modo offline (não muda para outro serviço pago);
- `procedural`: não faz chamadas externas.

O resultado informa o provedor realmente utilizado e o motivo resumido de fallback, sem revelar credenciais. A chamada externa tem timeout de 12 segundos.

### Validação local segura

1. Faça um backup com o servidor parado e valide com `verify`.
2. Rode o AutoFlow sempre com o mesmo `DATA_DIR`; use um diretório separado para testes.
3. Salve uma chave pela tela, feche e reinicie. Verifique que o status continua “configurada” e que a geração usa o provedor esperado.
4. Verifique com `npm test`; o teste de chaves verifica ciphertext, identidade da organização e alterações concorrentes.

**Não inclua** `DATA_DIR`, `vault-key.json`, arquivos `.env` ou backups no Git.
