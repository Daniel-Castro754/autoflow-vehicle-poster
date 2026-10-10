# Recuperação portátil das credenciais de IA — AutoFlow

## O que a recuperação resolve

O cofre `vault-key.json` do AutoFlow usa DPAPI CurrentUser, por isso um backup padrão do SQLite e desse arquivo **não desbloqueia as chaves Gemini/OpenAI em outro usuário Windows**.

A nova exportação `*.autoflow-recovery` protege **a chave mestra do cofre**, usando AES-256-GCM e scrypt, com uma senha de recuperação forte. **Não salva suas chaves Gemini/OpenAI como texto.** Ela deve ser guardada **fora do repositório e separada do backup normal**.

Esta função exige que a exportação seja feita enquanto a conta Windows **original ainda consiga abrir o cofre**. Ela não recupera chaves se esse usuário já foi perdido e não há um arquivo de recuperação criado anteriormente.

## 1. Criar uma recuperação na máquina original

Feche o AutoFlow (`Ctrl+C`) e abra PowerShell com a mesma conta Windows usada no programa. Na pasta do projeto:

```powershell
$env:DATA_DIR = ".\data"
npm run backup -- create ".\backups"
npm run vault:recovery -- export "D:\AutoFlow-Resgate\meu-cofre.autoflow-recovery"
```

Altere `DATA_DIR` para a pasta **real** usada pelo programa, que pode ser `.\data-ai-teste` ou `.\data-cofre-teste`. O caminho de exportação é apenas ilustrativo: use uma pasta existente e segura fora do repositório. **Não informe a senha na linha de comando**; o aplicativo solicitará duas vezes, sem exibi-la.

A senha precisa conter **pelo menos 16 caracteres**. Prefira uma frase longa, única e aleatória, guardada em um gerenciador de senhas. O exportador se recusa a sobrescrever um pacote antigo.

Para verificar que a senha abre o arquivo (sem alterar o banco):

```powershell
npm run vault:recovery -- verify "D:\AutoFlow-Resgate\meu-cofre.autoflow-recovery"
```

## 2. Restaurar em outro usuário ou computador Windows

No Windows novo, instale o AutoFlow, copie o backup do computador anterior e **restaure-o para um diretório vazio**. Não inicie o servidor antes de reconfigurar o cofre.

```powershell
$env:DATA_DIR = ".\data-restaurada"
npm run backup -- restore "D:\Backups\autoflow-backup-DATA-EXEMPLO" ".\data-restaurada"
npm run vault:recovery -- import "D:\AutoFlow-Resgate\meu-cofre.autoflow-recovery"
npm run dev
```

A recuperação solicitará confirmação e senha digitadas na sessão interativa do PowerShell. O sistema **verifica que a chave mestra corresponde às credenciais cifradas no banco antes de gravar qualquer alteração**. Depois disso, o arquivo `vault-key.json` será encapsulado pelo DPAPI do **novo usuário Windows**. O arquivo original será preservado sob o nome `vault-key.pre-recovery-*.json`.

## Proteções e limitações

- Nunca apague `autoflow.db`, `vault-key.json`, o backup original ou o pacote protegido para resolver um erro de senha.
- Uma senha incorreta, arquivo adulterado ou cofre não correspondente ao banco interrompe a operação **sem substituir o cofre**.
- O servidor deve estar desligado durante a importação e a exportação; não rode dois processos sobre o mesmo `DATA_DIR`.
- A importação exige um banco com **pelo menos uma credencial de IA criptografada**, para verificar a correspondência da chave.
- A importação portátil está disponível somente em **Windows**. O modo scrypt de Linux continua usando o segredo definido no ambiente.
- O pacote não inclui o banco, fotos ou grupos; mantenha o backup normal em local separado.
- Cópias podem conter informações pessoais, e um pacote de recuperação mais a senha possibilitam desbloquear as credenciais. Restrinja o acesso físico e digital.
- Arquivos `*.autoflow-recovery` são excluídos pelo `.gitignore` do projeto, mas não confie nisso como única proteção.

Testes automatizados: `npm run test:vault-recovery` em Node e `node tests/windows-recovery.mjs` no Windows.
