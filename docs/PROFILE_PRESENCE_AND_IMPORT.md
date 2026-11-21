# Ciclo 1–2: presença dos perfis Brave e entrada supervisionada de veículos

## O que foi implementado

- A extensão instalada em **cada perfil separado do Brave** envia um sinal autenticado
  `POST /api/extension/presence` na inicialização, no ciclo de verificação e ao
  trocar o perfil ativo. Sinaliza apenas comunicação com o servidor local.
- O endpoint valida o usuário e a associação à organização, não transmite
  cookies/senhas do Facebook e **não** renova leases de publicações.
- O painel **Equipe e contas** se atualiza a cada minuto. Diferencia:
  `Extensão conectada` (contato há menos de cinco minutos),
  `Sem sinal recente`, `Aguardando extensão` e `Automação pausada`.
- O roteamento **automático** só atribui novas tarefas a perfis com sinal
  recente (cinco minutos), além das regras de capacidade, pausa e duplicação.
  Trabalhos existentes não são deletados ou redistribuídos automaticamente.
- O sinal não demonstra login no Facebook nem permissão de publicar.
  A verificação de sessão do Marketplace continua ocorrendo na extensão.

## Atualização supervisionada dos perfis Brave

Depois de backup e atualização da aplicação Docker:

1. Em **cada** janela de perfil, abra `brave://extensions` e clique em
   **Recarregar** na extensão AutoFlow para Brave. Isso é importante porque
   mudanças no servidor não atualizam automaticamente a extensão descompactada.
2. Abra a extensão, confira o perfil selecionado e mantenha a sessão AutoFlow
   autenticada. Não compartilhe tokens nem cookies entre perfis.
3. Em **Equipe e contas**, verifique o estado de cada perfil.
4. Teste um perfil ativo, um perfil fechado e outro pausado. O perfil fechado
   deve perder o estado de presença após o limite de cinco minutos.
5. Verifique que a distribuição automática não destine novos trabalhos ao
   perfil fechado ou pausado. Não execute publicação real durante este teste.

**Limite:** a presença é um indicador operacional de comunicação, não um
atestado criptográfico de que um navegador específico ou o Facebook está aberto.

## Entrada de estoque com fotos: reaproveitar antes de reinventar

O AutoFlow **já possui** um importador de ZIP supervisionado
(`docs/VEHICLE_ZIP_IMPORT.md`) e CSV com importação de imagens por código
(`docs/CSV_PHOTO_IMPORT.md`). É a primeira etapa recomendada para eliminar
cadastros com 0 fotos, antes de ligar sincronizações externas contínuas.

Sequência segura para um lote real:

1. Monte um ZIP com CSV e fotos organizadas por identificador de estoque,
   respeitando os limites do importador.
2. Use **Veículos → Importar CSV ou ZIP** e analise a prévia, sem gravação.
3. Corrija duplicados, campos faltantes e fotos sem correspondência.
4. Confirme **apenas os veículos aceitos** no painel. A importação não cria
   publicações nem publica no Facebook.
5. Revise um veículo no estoque, conferindo fotos e descrição, antes de
   adicionar à fila da extensão.

### Activepieces já existente

Na organização conectada **Daniel's Project** existem:

- **Auto Flow 2.0 | Ponte local de rascunhos (sem publicar)**: fluxo
  publicado e habilitado, mas apenas retorna candidatos à ponte local;
  a criação real exige execução explícita no Windows e token de escopo restrito.
- **Auto Flow 2.0 | Importação v2 — triagem sem gravação**: rascunho
  desativado; validado estruturalmente com quatro etapas.
- **Organizar Imagens do Veículo**: rascunho desativado; validado
  estruturalmente com quatro etapas.

**Não habilitar a triagem por webhook como está**: seu gatilho de rascunho
não exige autenticação. Exigir um segredo por header, com rotação e limites,
antes de expor o fluxo. O organizador existente trabalha sobre nomes/URLs
em uma tabela Activepieces; não transfere automaticamente os binários das
fotos para o AutoFlow. Não confundir os dois processos.

Para a sincronização contínua futura, definir a origem autoritativa (CSV do
DMS/ERP, pasta compartilhada ou API oficial), periodicidade e dono dos dados.
Reutilizar a prévia/commit existente com proteção para estoque publicado e
trabalhos ativos. Não usar scraping do Facebook como fonte de estoque.

## Segurança da instalação

- Preservar `data/autoflow.db`, `data/uploads`, `data/vault-key.json` e
  o `.env` com o segredo original ao atualizar o Docker.
- Fazer um backup verificável e preservar uma cópia fora do computador.
- Não trocar o `AUTH_SECRET` sem migração segura do cofre criptografado.
- A regra de cinco minutos protege **somente novas atribuições automáticas**.
  Não conclui, cancela ou repete anúncios previamente tentados.
