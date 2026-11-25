import { useEffect, useState } from 'react'

type Profile = {
  id:number;label:string;online:boolean;lastSeenAt:string|null
  consumer:{state:string;reportedAt:string|null}
  decision:{code:string;receivedAt:string;jobId?:number;httpStatus?:number}|null
  reasons:string[];queue:{pending:number;restricted:number}
  capacity:{used:number;queuedToday:number;dailyLimit:number;remaining:number;nextAllowedAt:string|null}
}
type Review = {id:number;vehicleId:number;accountId:number|null;title:string;status:string;reviewKind:string|null;paused:boolean;visible:boolean}
type Event = {id:number;jobId:number;vehicleId:number;title:string;eventType:string;createdAt:string;accountLabel:string|null;fromLabel:string|null;toLabel:string|null;automatic:number|null;conflictCode?:string|null}
type Snapshot = {timestamp:string;filters:{accountId:number;vehicleId:number;hours:number;category:string;beforeId:number;limit:number};profiles:Profile[];reviews:Review[];reviewCount:number;activity:Event[];nextBeforeId:number|null}
const labels:Record<string,string> = {
 lease_mismatch:'Bloqueio incompatível',identity_mismatch:'Documento incompatível',lease_expired:'Bloqueio expirado',status_changed:'Estado alterado',result_conflict:'Resultado incompatível',
 offline:'Sem sinal recente',server_paused:'Pausa no servidor',consumer_paused:'Consumo pausado',consumer_unknown:'Consumo sem sinal recente',daily_limit:'Limite de execuções',queue_daily_limit:'Limite de agendamentos',operational_interval:'Intervalo operacional',
 enabled:'Ativo',paused:'Pausado',unknown:'Desconhecido',
 consumer_check_failed:'Falha de comunicação',facebook_not_ready:'Facebook requer revisão',dispatch_failed:'Falha de despacho',dispatch_confirmed:'Envio confirmado',queue_empty:'Fila vazia',no_eligible_job:'Sem trabalho elegível',scheduled_wait:'Aguardando horário',execution_pending:'Execução pendente',job_selected:'Trabalho selecionado',prepare_rejected:'Preparação rejeitada',api_unauthorized:'API requer autenticação',queue_http_error:'Erro HTTP na fila',session_missing:'Sessão ausente',
 publication_uncertain:'Publicação incerta',fill_incomplete:'Preenchimento incompleto',manual_review:'Revisão manual',review_unknown:'Resultado desconhecido',error:'Erro',
 reassigned:'Redistribuição',stalled_recovered:'Recuperação automática',auto_retry_scheduled:'Nova tentativa agendada',autopilot_scheduled:'Agendamento pelo piloto',filling_started:'Preenchimento iniciado',filled_waiting_confirmation:'Aguardando confirmação',confirmed_published:'Publicação confirmada',auto_published:'Publicação automática confirmada',publish_result_unknown:'Resultado incerto',stalled_publish_ambiguous:'Interrupção com publicação incerta',stalled_exhausted:'Recuperação esgotada',fill_result_conflict:'Resultado rejeitado — revisar evidências',fill_error:'Erro no preenchimento',duplicate_blocked:'Bloqueio preventivo de duplicidade',
}
const label=(code:string)=>labels[code]||code.replaceAll('_',' ')
const date=(value:string|null)=>value?new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value)?value:value.replace(' ','T')+'Z').toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'—'

export function OperationalMonitor({api}:{api:<T>(path:string)=>Promise<T>}) {
  const [account,setAccount]=useState('')
  const [vehicle,setVehicle]=useState('')
  const [category,setCategory]=useState('all')
  const [hours,setHours]=useState('24')
  const [cursor,setCursor]=useState<number|null>(null)
  const [refresh,setRefresh]=useState(0)
  const [data,setData]=useState<Snapshot|null>(null)
  const [error,setError]=useState('')
  useEffect(()=>{
    let active=true
    let timer:ReturnType<typeof setTimeout>|undefined
    const query=new URLSearchParams({category,hours,limit:'30'})
    if(account) query.set('accountId',account)
    if(vehicle) query.set('vehicleId',vehicle)
    if(cursor) query.set('beforeId',String(cursor))
    async function load(){
      try{
        const result=await api<Snapshot>('/operations/monitor?'+query)
        if(active){setData(result);setError('')}
      }catch{if(active)setError('Não foi possível atualizar. Dados anteriores podem estar desatualizados.')}
      finally{if(active&&!cursor)timer=setTimeout(()=>void load(),30000)}
    }
    void load()
    return()=>{active=false;clearTimeout(timer)}
  },[api,account,vehicle,category,hours,cursor,refresh])
  function reset(){setCursor(null);setData(null)}
  function download(){
    if(!data)return
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}))
    const link=document.createElement('a')
    link.href=url;link.download='autoflow-monitor-'+data.timestamp.replaceAll(':','-')+'.json'
    link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  return <article className="module-card operational-health">
    <div className="module-head"><div><h2>Monitoramento operacional</h2><span>Último sinal e decisões da extensão; histórico selecionado de trabalhos</span></div></div>
    <p className="health-note">Sinal recente não comprova login no Facebook. Eventos antigos sem perfil registrado não são atribuídos ao perfil atual. Horários de Brasília.</p>
    <div className="intervention-filter">
      <label>Perfil <select value={account} onChange={e=>{setAccount(e.target.value);reset()}}><option value="">Todos</option>{data?.profiles.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}{account&&!data&&<option value={account}>#{account}</option>}</select></label>
      <label>ID do veículo <input type="number" min="1" value={vehicle} onChange={e=>{setVehicle(e.target.value);reset()}} /></label>
      <label>Período <select value={hours} onChange={e=>{setHours(e.target.value);reset()}}><option value="24">24 horas</option><option value="168">7 dias</option><option value="720">30 dias</option></select></label>
      <label>Evento <select value={category} onChange={e=>{setCategory(e.target.value);reset()}}><option value="all">Todos</option><option value="scheduling">Agendamento</option><option value="execution">Execução</option><option value="recovery">Recuperação</option><option value="transfer">Redistribuição</option><option value="attention">Requer atenção</option></select></label>
      <button type="button" onClick={()=>setRefresh(n=>n+1)}>Atualizar</button>
      <button type="button" disabled={!data||Boolean(error)} onClick={download}>Exportar página JSON</button>
    </div>
    {error&&<p role="status" className="health-error">{error}</p>}
    {!data&&!error&&<p role="status">Consultando monitoramento…</p>}
    {data&&<>
      <p className="health-note">Atualizado: {date(data.timestamp)} · {cursor?'Página anterior (sem atualização automática)':'Atualização a cada 30 segundos'}</p>
      <div className="health-table-wrap"><table className="health-table"><caption>Perfis e capacidade diária — todos os perfis</caption><thead><tr><th>Perfil</th><th>Conexão / consumo</th><th>Execuções / agendamentos</th><th>Fila pendente</th><th>Última decisão / bloqueios</th></tr></thead><tbody>{data.profiles.map(p=><tr key={p.id}>
      <th scope="row">{p.label}</th><td>{p.online?'Sinal recente':'Sem sinal recente'} · {label(p.consumer.state)}<small className="job-report">{date(p.lastSeenAt)}</small></td>
      <td>{p.capacity.used}/{p.capacity.dailyLimit} executadas · {p.capacity.queuedToday} criadas<small className="job-report">Próximo permitido: {date(p.capacity.nextAllowedAt)}</small></td>
      <td>{p.queue.pending} ({p.queue.restricted} pausadas/ocultas)</td>
      <td>{p.decision?label(p.decision.code)+(p.decision.jobId?' · #'+p.decision.jobId:'')+(p.decision.httpStatus?' · HTTP '+p.decision.httpStatus:''):'Sem decisão recente'}<small className="job-report">{p.reasons.map(label).join(' · ')||'Sem restrição de perfil detectada'}</small></td>
      </tr>)}</tbody></table></div>
      <div className="health-table-wrap"><table className="health-table"><caption>Trabalhos para revisão — {data.reviews.length} de {data.reviewCount} (estado atual, independente do período)</caption><thead><tr><th>Trabalho</th><th>Veículo</th><th>Perfil</th><th>Motivo</th></tr></thead><tbody>{data.reviews.map(j=><tr key={j.id}><td>#{j.id}</td><td>#{j.vehicleId} · {j.title}</td><td>{data.profiles.find(p=>p.id===j.accountId)?.label||'—'}</td><td>{label(j.reviewKind||j.status)}{j.paused?' · pausado':''}{!j.visible?' · oculto':''}</td></tr>)}</tbody></table></div>
      <div className="health-table-wrap"><table className="health-table"><caption>Histórico filtrado — {data.activity.length} eventos (tipos operacionais selecionados)</caption><thead><tr><th>Horário</th><th>Trabalho / veículo</th><th>Evento</th><th>Perfil registrado</th></tr></thead><tbody>{data.activity.map(e=><tr key={e.id}><td>{date(e.createdAt)}</td><td>#{e.jobId} · #{e.vehicleId} {e.title}</td><td>{label(e.eventType)}{e.conflictCode?' · '+label(e.conflictCode):''}{e.automatic?' · automático':''}</td><td>{e.fromLabel||e.toLabel?(e.fromLabel||'—')+' → '+(e.toLabel||'—'):e.accountLabel||'Não registrado'}</td></tr>)}</tbody></table></div>
      {!data.activity.length&&<p className="health-note">Sem eventos para os filtros selecionados.</p>}
      <div className="intervention-filter"><button type="button" disabled={!cursor} onClick={()=>{setCursor(null);setData(null)}}>Mais recentes</button><button type="button" disabled={!data.nextBeforeId} onClick={()=>{setCursor(data.nextBeforeId);setData(null)}}>Eventos anteriores</button></div>
    </>}
  </article>
}
