import type { ReadinessState } from './system-readiness.ts'

export type GuidePriority = 'critical' | 'high' | 'normal' | 'verification'
export type GuidedAction = {
  id: string
  checkId: string
  priority: GuidePriority
  title: string
  summary: string
  reason: string
  steps: string[]
  destination: string
  destinationLabel: string
  safety: string
  requiresHumanApproval: true
  performsChanges: false
}

type CheckInput = {
  id: string
  status: ReadinessState
}

type GuideTemplate = Omit<
  GuidedAction,
  'id' | 'checkId' | 'requiresHumanApproval' | 'performsChanges'
>

const templates: Record<string, GuideTemplate> = {
  vault: {
    priority: 'critical',
    title: 'Proteger credenciais antigas',
    summary: 'Verifique o cofre e preserve os dados antes de qualquer migração.',
    reason: 'O diagnóstico local encontrou campos que não usam o formato cifrado esperado.',
    steps: [
      'Pare o AutoFlow e faça um backup completo do DATA_DIR, incluindo o SQLite e vault-key.json.',
      'Verifique o backup antes de testar mudanças; nunca apague o cofre ou gere outro sobre o banco existente.',
      'Confira se a instalação foi iniciada com o mesmo usuário Windows e o mesmo DATA_DIR.',
      'Se o aviso persistir após reiniciar com segurança, consulte os logs de migração sem compartilhar credenciais.',
    ],
    destination: 'Configurações',
    destinationLabel: 'Revisar configurações',
    safety: 'Não rotaciona, descifra, exporta nem remove chaves automaticamente.',
  },
  backup: {
    priority: 'verification',
    title: 'Verificar backup e restauração',
    summary: 'Comprove que existe uma cópia recuperável antes de usar automações de maior risco.',
    reason: 'Este painel não executa restaurações; o estado é desconhecido, não uma falha confirmada.',
    steps: [
      'Pare o servidor antes de copiar manualmente o DATA_DIR ou use o comando de backup do projeto.',
      'Execute a verificação de integridade prevista em npm run backup e guarde uma cópia fora da pasta do projeto.',
      'Teste a restauração em um diretório separado, nunca sobre o banco em uso.',
      'No Windows, confira as limitações do DPAPI e mantenha o pacote de recuperação e a senha separados do backup.',
    ],
    destination: 'Configurações',
    destinationLabel: 'Ver configurações',
    safety: 'A tela não acessa arquivos locais nem declara um backup como verificado.',
  },
  ai: {
    priority: 'normal',
    title: 'Revisar provedor de IA',
    summary: 'Confira a seleção Gemini/OpenAI e a configuração da chave correspondente.',
    reason: 'O provedor escolhido não possui a configuração local mínima encontrada.',
    steps: [
      'Abra a Central de IA e verifique se o provedor selecionado corresponde ao serviço desejado.',
      'Em Configurações, cadastre ou substitua a chave necessária e clique em Salvar configurações.',
      'Use a opção de testar a chave apenas se desejar fazer uma solicitação externa ao provedor.',
      'Confira o provedor efetivamente utilizado e qualquer fallback offline antes de aprovar descrições.',
    ],
    destination: 'Central de IA',
    destinationLabel: 'Abrir Central de IA',
    safety: 'Não testa nem altera chaves. Testes externos permanecem ações separadas.',
  },
  telegram: {
    priority: 'normal',
    title: 'Completar alerta Telegram',
    summary: 'Confira o token do bot e o destino da conversa.',
    reason: 'Há apenas parte da configuração necessária para o canal Telegram.',
    steps: [
      'Abra Configurações e confira se o token do bot está marcado como configurado.',
      'Confira se o Chat ID também aparece como configurado; não publique token ou ID no chat.',
      'Salve novas credenciais apenas quando precisar substituí-las; campos vazios preservam as existentes.',
      'Faça o teste de envio na área de notificações, se quiser verificar o canal real.',
    ],
    destination: 'Configurações',
    destinationLabel: 'Ver notificações',
    safety: 'Não envia mensagem Telegram nem revela os segredos existentes.',
  },
  profiles: {
    priority: 'high',
    title: 'Conferir conexão das extensões',
    summary: 'Verifique perfis desconectados ou pausados antes de liberar a execução.',
    reason: 'O sinal local não indica extensão recente suficiente ou existe pausa de segurança.',
    steps: [
      'Abra Equipe e contas e confira os perfis indicados como pausados ou sem conexão recente.',
      'Abra o Brave e confirme se a extensão AutoFlow está ativa no perfil correto.',
      'Verifique a sessão Facebook manualmente; um heartbeat não garante login válido.',
      'Se houver pausa por falha dos seletores, revise o incidente antes de retomar pela tela apropriada.',
    ],
    destination: 'Equipe e contas',
    destinationLabel: 'Ver perfis',
    safety: 'Nunca reativa perfis nem interage com o Facebook automaticamente.',
  },
  groups: {
    priority: 'high',
    title: 'Revisar grupos sem excluir registros',
    summary: 'Reveja grupos desativados e a configuração de preenchimento.',
    reason: 'O preenchimento de grupos está ligado, mas nenhum grupo aparece como ativo.',
    steps: [
      'Faça um backup do catálogo de grupos e do banco antes de qualquer reorganização.',
      'Em Configurações, veja a quantidade total de grupos e quais estão marcados como inativos.',
      'Reative somente os grupos desejados, mediante sua revisão, e salve a seleção.',
      'Não utilize exclusão em massa nem presuma que grupo inativo foi apagado; confira o catálogo após salvar.',
    ],
    destination: 'Configurações',
    destinationLabel: 'Ver catálogo de grupos',
    safety: 'Não exclui, desativa, reordena ou importa grupos via IA.',
  },
  pilot: {
    priority: 'high',
    title: 'Revisar impedimentos do piloto automático',
    summary: 'Resolva os alertas existentes antes de confiar no agendamento recorrente.',
    reason: 'O piloto está ligado, mas uma ou mais pré-condições locais apresentam risco.',
    steps: [
      'Revise os roteiros de extensões, grupos e fila que estejam marcados como atenção.',
      'Abra Central de IA e examine a prévia do piloto antes de aprovar uma execução.',
      'Confirme limites diários, perfil disponível e situação do estoque.',
      'Se houver trabalho de publicação com resultado incerto, verifique o Facebook antes de tentar novamente.',
    ],
    destination: 'Central de IA',
    destinationLabel: 'Revisar piloto automático',
    safety: 'Não executa piloto, publica nem agenda novos trabalhos.',
  },
  jobs: {
    priority: 'critical',
    title: 'Conferir fila e publicações incertas',
    summary: 'Priorize trabalhos travados e publicações que aguardam confirmação.',
    reason: 'Há trabalhos travados, leases expiradas ou confirmações pendentes.',
    steps: [
      'Abra Publicações e identifique os trabalhos com aviso ou confirmação pendente.',
      'Se o clique em Publicar pode ter ocorrido, confira Seus classificados no Facebook antes de qualquer nova tentativa.',
      'Resolva ou confirme o estado do anúncio na tela operacional apropriada.',
      'Só retome tentativas depois de avaliar risco de duplicação e a política de aprovação.',
    ],
    destination: 'Publicações',
    destinationLabel: 'Abrir fila',
    safety: 'Não libera fila, remove confirmação nem dispara republicação automaticamente.',
  },
}

const priorityOrder: Record<GuidePriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  verification: 3,
}

/** Fixed, deterministic playbooks. Ignores untrusted descriptions and stored secrets. */
export function guidedRemediation(checks: readonly CheckInput[]): GuidedAction[] {
  return checks
    .filter((item) => item.status === 'attention' || (item.id === 'backup' && item.status === 'unknown'))
    .flatMap((item) => {
      const template = Object.hasOwn(templates, item.id) ? templates[item.id] : undefined
      return template
        ? [{
            ...template,
            id: 'guide-' + item.id,
            checkId: item.id,
            steps: [...template.steps],
            requiresHumanApproval: true as const,
            performsChanges: false as const,
          }]
        : []
    })
    .sort(
      (a, b) =>
        priorityOrder[a.priority] - priorityOrder[b.priority] ||
        a.checkId.localeCompare(b.checkId),
    )
}
