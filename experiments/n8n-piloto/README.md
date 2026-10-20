# Protótipo alternativo Auto Flow — n8n (sem publicar)

**Prova de conceito independente:** não utiliza o banco, as credenciais, o Brave ou a API do Auto Flow.

## Requisitos
- Windows 10/11 com Docker Desktop em execução
- Porta 5678 livre
- Git para baixar esta branch experimental (ou salvar os arquivos pela interface GitHub)

## Inicialização
1. Faça download dos arquivos desta pasta (`docker-compose.yml`, ambos os JSON de workflows e `dados/veiculos-demo.csv`) preservando a estrutura.
2. Abra PowerShell nesta pasta.
3. Execute `docker compose up -d`.
4. Abra http://localhost:5678 e crie sua conta local de proprietário no n8n.
5. Na interface do n8n, crie um workflow e use a opção **Import from File** para abrir `workflow-01-demonstracao.json`.
6. Clique em **Execute Workflow**. Abra o nó `Relatorio final`. São esperados 6 recebidos, 3 aprovados, 2 revisar, 1 duplicado.
7. Importe `workflow-02-importar-csv.json` da mesma maneira. Execute; este workflow lê o arquivo `/files/veiculos-demo.csv` do container montado pelo Docker Compose. Esperam-se os mesmos valores.

**No n8n, o caminho /files NÃO é o caminho Windows.** É o volume de demonstração mapeado em `./dados:/files:ro`.

## Estrutura dos fluxos
```
Iniciar teste -> Veículos de exemplo -> Padronizar -> Validar -> Duplicidades -> Gerar rascunhos -> Relatório
Iniciar teste -> Ler CSV -> Extrair CSV -> Padronizar -> Validar -> Duplicidades -> Gerar rascunhos -> Relatório
```

Este protótipo:
- Lê dados fictícios e um CSV demonstrativo;
- Normaliza campos, datas e valores monetários;
- Bloqueia itens sem preço/fotos e códigos de estoque repetidos;
- Gera descrições e uma fila apenas em memória;
- Mostra um relatório final com itens aptos e motivos de rejeição.

**Não contém credenciais, nós HTTP, rotina de agenda automática nem qualquer publicação.** Não o ative como workflow agendado.

## Encerrar
`docker compose stop`

Dados do próprio n8n são preservados em volume `n8n_data`. Não execute `docker compose down -v` se desejar mantê-los.

## Evoluções para comparar com Auto Flow
1. Processar um CSV copiado e anonimizado da sua operação, ajustando nomes de colunas.
2. Persistir a fila em banco dedicado, com estados idempotentes e auditoria.
3. Criar validação de fotos no sistema de arquivos sem copiá-las desnecessariamente.
4. Só depois integrar execução autorizada no Brave, com confirmação humana em ambiente de teste.
5. Comparar o número de erros, etapas manuais, logs, tempo de operação e facilidade de manutenção.

Fontes:
- https://docs.n8n.io/deploy/host-n8n/install-options/install-using-docker-compose/
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.extractfromfile/
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.readwritefile/
