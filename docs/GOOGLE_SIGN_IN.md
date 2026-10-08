# Acesso com Google

O Google é uma alternativa ao login existente. A integração usa o botão oficial do Google
Identity Services e valida os tokens na API com `google-auth-library`.

## Configurar

1. Abra o [Google Auth Platform](https://console.cloud.google.com/auth/overview) e crie ou selecione
   um projeto. Preencha o nome do app, e-mail de suporte e público na tela de consentimento.
   Se o projeto estiver em modo de teste, inclua os usuários de teste necessários.
2. Em **Clientes**, crie um cliente OAuth do tipo **Aplicativo da Web**.
3. Em **Origens JavaScript autorizadas**, cadastre as origens em que o painel será aberto:
   - Desenvolvimento: `http://localhost` e `http://localhost:5173`.
   - Painel servido pela API/container: `http://localhost:3333`, se esta for a origem usada.
   - Produção: o domínio HTTPS real, por exemplo `https://autoflow.suaempresa.com`.
     Use a origem exata, incluindo a porta quando houver, sem `/api` nem outros caminhos.
4. Copie o **ID do cliente** para o `.env` na raiz do projeto:

   ```dotenv
   GOOGLE_CLIENT_ID=seu-client-id.apps.googleusercontent.com
   ```

5. Reinicie a API (`npm run dev` em desenvolvimento). Abra o painel pela origem autorizada.
   O botão **Entrar com Google** aparecerá abaixo do formulário de senha.

Esse fluxo usa popup com callback JavaScript: não exige Client Secret nem URI de redirecionamento.
Não solicita acesso a Gmail, Drive ou outros dados Google. O Client ID é público e é entregue
ao painel pela API; mantenha o `.env` fora do Git, pois ele contém outros segredos do app.

Em produção, configure também `PUBLIC_ORIGIN` (origem pública da API) e `CORS_ORIGINS`
(origens permitidas do painel). No container local aberto em `http://localhost:3333`, use
`PUBLIC_ORIGIN=http://localhost:3333`. Se optar por outra origem, ajuste as duas configurações
e o cadastro no Google de acordo com ela.

O painel usa `/api` por padrão: o Vite encaminha as chamadas à API local, e o container atende
painel e API na mesma origem. Se hospedar a API separadamente, defina
`VITE_API_URL=https://api.suaempresa.com/api` **antes do build**, e inclua a origem do painel
em `CORS_ORIGINS`. A integração não depende de cookies de terceiros na API.

## Vincular e entrar

1. Cadastre o usuário normalmente no AutoFlow, com o mesmo e-mail da conta Google.
2. Clique em **Entrar com Google** e selecione a conta.
3. Na primeira vez, confirme a senha do **AutoFlow** em **Conectar Google e entrar**.
   A senha Google é informada somente na janela do próprio Google.
4. Saia do painel e entre novamente com Google: a senha AutoFlow não será solicitada.

O vínculo é salvo pelo identificador permanente da conta Google (`sub`). As permissões,
empresa e situação ativa são sempre lidas do usuário local. Contas desconhecidas, desativadas
ou já vinculadas a outro identificador são recusadas. Não há cadastro automático nem
substituição de vínculos existentes. A senha local continua funcionando após a vinculação.

## Validação e diagnóstico

- `npm run test:google-auth` valida assinaturas RSA e claims com chaves de teste, sem acessar
  o Google. Cobre primeira vinculação, senha incorreta, repetição/expiração, isolamento por
  empresa, desativação, limitação de tentativas e login tradicional. Faz parte de `npm test`.
- Validação real: com um Client ID configurado, teste a primeira conexão, logout, nova entrada,
  cancelamento da janela Google e login por senha no Chrome/Brave usado pela equipe.
- Botão ausente: confira `GOOGLE_CLIENT_ID` no processo da API e reinicie-o.
- Origem não autorizada: confira protocolo, domínio e porta no Google Auth Platform e em
  `CORS_ORIGINS`. Para desenvolvimento, prefira `http://localhost:5173`.
- Google bloqueado pelo navegador/rede: permita a janela de acesso e o carregamento de
  `https://accounts.google.com/gsi/client`. O login por senha permanece disponível.
- Conexão expirada ou senha incorreta: clique em **Tentar Google novamente**. Cada tentativa
  e confirmação é de uso único e expira após cinco minutos.
- API sem internet: a verificação pode falhar ao renovar os certificados públicos Google;
  os detalhes e tokens da resposta externa não são enviados ao navegador nem aos logs.

Sem `GOOGLE_CLIENT_ID`, a integração fica desativada e a API mantém o login original.
O schema é atualizado pela migration 11, sem alterar os hashes de senha ou migrations antigas.
Somente o identificador Google é persistido; tokens de identidade e senhas de confirmação não
são armazenados. Sessões Google têm a mesma validade de 12 horas e revogação do login local.

Referências oficiais: [configuração do cliente](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid),
[validação no servidor](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
e [API JavaScript](https://developers.google.com/identity/gsi/web/reference/js-reference).
