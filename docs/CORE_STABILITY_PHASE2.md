# Estabilidade do núcleo — Fase 2

## Correções propostas

1. **npm ci isolado:** o launcher copia apenas `package.json`, `package-lock.json` e `.npmrc`
   para um diretório temporário ignorado pelo Git, executa a instalação ali
   e só substitui `node_modules` depois de sucesso.
2. **Recuperação de troca interrompida:** se o Windows encerrar o EXE entre
   as movimentações, a próxima inicialização restaura a árvore anterior.
   Se a árvore atual estiver presente, a cópia anterior permanece até API
   e painel estarem saudáveis. Falhas de preparação preservam dependências ativas.
3. **Build de extensão em staging:** o diretório `dist/extension`
   e o ZIP existente permanecem intactos enquanto o novo pacote é preparado.
   Uma marca de transação incompleta força a nova compilação na próxima abertura.
4. **Limpeza após timeout de startup:** apenas a árvore de subprocessos que
   esta janela iniciou é encerrada. Não mexe em servidores externos ou previamente ativos.

## Validações no CI

- Windows smoke: npm staging falho, troca com backup, restauração interrompida,
  limpeza após readiness, além dos testes prévios de processos e IPv6.
- Node: criação do ZIP, preservação do build após manifesto inválido e
  recuperação de um backup criado antes de um encerramento inesperado.
- Build do EXE e suíte geral existente.

## Limitações deliberadas

- **Não há rollback do Git/SQLite.** Alterar automaticamente `HEAD`
  depois de uma migração pode deixar dados incompatíveis. Essa decisão exige
  versão de esquema, estratégia de backup/restauração e validação de compatibilidade.
- Estágios de instalação interrompidos antes da troca podem ficar em
  `.autoflow-launcher-recovery` e ser removidos após diagnóstico.
- Falhas reais de permissão, antivírus, disco cheio, extensão carregada pelo
  navegador e interrupção elétrica dependem de homologação no Windows do usuário.
- A extensão carregada no Brave ainda necessita recarregamento manual.

A implementação não altera o fluxo de anúncios, credenciais, SQLite ou
limites operacionais.
