import type { DatabaseSync } from 'node:sqlite'
import { operationalBottlenecks } from './operational-bottlenecks.ts'

type Handling = 'manual_review' | 'operator_check' | 'observe' | 'respect_configuration'
type Guidance = { handling: Handling; instruction: string }
const guidance: Record<string, Guidance> = {
  open_result_conflict: {handling:'manual_review',instruction:'Confira as evidências e resolva o conflito no painel antes de qualquer nova tentativa.'},
  publication_uncertain: {handling:'manual_review',instruction:'Verifique Seus classificados no Facebook e concilie o resultado no painel; não repita enquanto houver incerteza.'},
  manual_review: {handling:'manual_review',instruction:'Revise o formulário, os campos e o estado real do anúncio antes de confirmar ou solicitar nova tentativa.'},
  execution_error: {handling:'operator_check',instruction:'Consulte o diagnóstico do trabalho e o saldo de tentativas. Corrija a causa antes de decidir sobre nova execução.'},
  missing_photos: {handling:'operator_check',instruction:'Anexe fotos reais do veículo e confira os arquivos no cadastro.'},
  incomplete_vehicle: {handling:'operator_check',instruction:'Consulte os campos faltantes e complete o cadastro com dados verificados.'},
  shared_photo: {handling:'manual_review',instruction:'Confira os cadastros e as fotos coincidentes. Use o cadastro correto; não altere fotos para contornar a proteção.'},
  no_eligible_profile: {handling:'operator_check',instruction:'Confira os motivos de inelegibilidade dos perfis; respeite pausas, limites e autorizações.'},
  profile_disconnected: {handling:'operator_check',instruction:'Confira se o navegador e a extensão do perfil estão disponíveis. Se necessário, autentique-se manualmente.'},
  profile_stale: {handling:'operator_check',instruction:'Confira a presença recente da extensão e a comunicação com a API local.'},
  consumer_unknown: {handling:'observe',instruction:'Aguarde uma confirmação recente de consumo ativo; se não chegar, confira a conexão da extensão.'},
  consumer_operational_block: {handling:'operator_check',instruction:'Consulte o último diagnóstico do consumidor. Preserve bloqueios e aguarde evidência de recuperação.'},
  profile_paused: {handling:'respect_configuration',instruction:'Preserve a pausa do perfil. Somente o operador autorizado pode avaliar a retomada após verificar a causa.'},
  consumer_paused: {handling:'respect_configuration',instruction:'Respeite a pausa do consumidor. Não reative automaticamente.'},
  queue_daily_limit: {handling:'respect_configuration',instruction:'Aguarde a capacidade prevista pelas regras vigentes; não aumente limites para compensar.'},
  existing_pending_or_active: {handling:'observe',instruction:'Acompanhe o agendamento e a execução existentes; não crie outro trabalho para contornar a espera.'},
  existing_confirmed_work: {handling:'observe',instruction:'Confira o registro local do trabalho concluído. Não presuma que o anúncio ainda está ativo no Facebook.'},
  existing_listing_guard: {handling:'respect_configuration',instruction:'Preserve a proteção contra duplicidade e confira o anúncio registrado antes de qualquer decisão.'},
  recurrence_disabled: {handling:'respect_configuration',instruction:'O piloto recorrente está desativado. Preserve essa escolha até decisão explícita do operador.'},
}

export function operationalRecommendations(db: DatabaseSync, org: number, limit = 10) {
  const snapshot=operationalBottlenecks(db,org,limit)
  return {
    recurringEnabled:snapshot.recurringEnabled,
    eligibleProfiles:snapshot.eligibleProfiles,
    readyVehicles:snapshot.readyVehicles,
    passingInitialChecks:snapshot.passingInitialChecks,
    recommendations:snapshot.findings.map(finding=>({
      ...finding,
      ...(guidance[finding.code]??{handling:'operator_check',instruction:'Confira a evidência no painel antes de decidir sobre qualquer alteração.'}),
      executed:false,
    })),
    note:'Orientações determinísticas baseadas no diagnóstico atual. Não constituem autorização de execução, não alteram o banco e não confirmam o estado externo. Contagens por motivo podem se sobrepor.',
  }
}
