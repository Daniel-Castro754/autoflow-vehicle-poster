# Fase 2 — resiliência da extensão

## Implementado

- A extensão pode solicitar uma sessão renovável apenas pelo login com senha iniciado em origem `chrome-extension://`. A API emite um grant aleatório de 256 bits, guarda **apenas SHA-256** no SQLite e o rotaciona sob `BEGIN IMMEDIATE`.
- A sessão curta continua com 12 horas. A concessão de renovação é revogável e limitada a 30 dias, sem prorrogação indefinida. Logout, usuário desativado e concessão inválida impedem renovação.
- O service worker da extensão centraliza renovações em uma única Promise para não ocorrerem rotações simultâneas em chamadas da mesma instância. Erros de rede não causam logout, mas rejeição definitiva desativa o consumo automático sem apagar evidências ou resultados pendentes.
- Antes de reservar um job automático ou manual, a extensão espera pela disponibilidade do formulário do Marketplace. Se detectar login necessário ou desafio humano, **não reserva o job**, pausa o consumo automático e deixa a aba para intervenção manual.
- Se uma página for recarregada contendo fotos cuja identidade não possa ser confirmada, a automação não interpreta somente a contagem como prova de upload completo. Ela interrompe a publicação automática e exige revisão.

## Limitações importantes

- A verificação do Facebook é **heurística baseada no DOM do formulário**, não autenticação via API oficial. Não lê, exporta ou modifica cookies e não tenta contornar CAPTCHA.
- A retomada de upload após recarregamento não pode ser garantida sem identidade verificável das imagens exibidas no Facebook. É intencional que o sistema falhe de forma segura nesses casos.
- Os grants de renovação ficam em `chrome.storage.local` e devem ser protegidos como credenciais. A revogação depende do acesso à API local; não compartilhe o perfil do Brave com usuários não confiáveis.
- Alterações no DOM do Facebook podem exigir atualização dos seletores.
- Migração 13 adiciona a tabela `extension_refresh_sessions`. Faça backup do SQLite antes da atualização.

## Validação

Execute `npm test`, `npm run typecheck`, `npm run lint` e `npm run format:check`. Homologue manualmente o primeiro login, sessão de 12 horas expirada, pausa diante de CAPTCHA/login e a reconciliação de publicações incertas.
