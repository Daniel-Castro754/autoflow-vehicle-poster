import type { DatabaseSync } from 'node:sqlite'
import { operationalRecommendations } from './operational-recommendations.ts'

const labels: Record<string,string> = {
  open_result_conflict:'Conflitos de resultado', publication_uncertain:'Publicação incerta',
  manual_review:'Revisão manual', execution_error:'Erro de execução',
  missing_photos:'Fotos ausentes', incomplete_vehicle:'Cadastro incompleto', shared_photo:'Fotos coincidentes',
  no_eligible_profile:'Veículos sem perfil elegível', profile_disconnected:'Perfis desconectados',
  profile_stale:'Perfis sem presença recente', consumer_unknown:'Consumo não confirmado',
  consumer_operational_block:'Falha operacional do consumidor', profile_paused:'Perfis pausados',
  consumer_paused:'Consumidores pausados', queue_daily_limit:'Limite diário atingido',
  existing_pending_or_active:'Trabalho pendente ou em andamento', existing_confirmed_work:'Trabalho concluído registrado',
  existing_listing_guard:'Proteção de anúncio existente', recurrence_disabled:'Piloto recorrente desativado',
}
const units={jobs:'trabalho(s)',vehicles:'veículo(s)',profiles:'perfil(is)',configuration:'configuração'}
const priorities={review:'Revisão',attention:'Atenção',waiting:'Espera'}

// Fixed guidance and identifiers only; no model call, secret or arbitrary
// description. The daily report and on-demand command share the same logic.
export function supervisorReport(db:DatabaseSync,org:number,compact=false) {
  const snapshot=operationalRecommendations(db,org,3)
  const maximum=compact?3:6
  const findings=snapshot.recommendations.slice(0,maximum)
  const lines=[
    '🔎 AutoFlow — supervisão operacional',
    'Piloto recorrente: '+(snapshot.recurringEnabled?'ativado':'desativado'),
    'Perfis elegíveis: '+snapshot.eligibleProfiles,
    'Veículos prontos: '+snapshot.readyVehicles+' · passam nas verificações iniciais: '+snapshot.passingInitialChecks,
    ...(findings.length?[]:['Nenhum dos gargalos monitorados foi identificado nesta consulta.']),
  ]
  for(const finding of findings){
    const examples=finding.exampleIds.length?' (#'+finding.exampleIds.join(', #')+')':''
    lines.push(priorities[finding.severity]+': '+(labels[finding.code]||'Verificação operacional')+' — '+finding.count+' '+units[finding.unit]+examples)
    if(!compact)lines.push('Orientação: '+finding.instruction)
  }
  if(snapshot.recommendations.length>maximum)lines.push('Outros tipos de ocorrência: '+(snapshot.recommendations.length-maximum)+'. Consulte o painel'+(compact?' ou /supervisao':'')+'.')
  lines.push('Dados locais; contagens podem se sobrepor. Nenhuma ação foi executada.')
  return lines.join('\n')
}
