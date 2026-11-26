import {useEffect,useState} from 'react'
type Api=<T=Record<string,unknown>>(path:string,options?:RequestInit)=>Promise<T>
type State={enabled:boolean;configured:boolean;requiresRebind:boolean;usage:{used:number;limit:number;day:string};history:Array<{eventId:number;jobId:number;family:string;cause:string;analysisStatus:string;deliveryStatus:string}>}
export function CommanderDiagnosticSettings({api}:{api:Api}){
  const [state,setState]=useState<State|null>(null)
  const [enabled,setEnabled]=useState(false)
  const [ack,setAck]=useState(false)
  const [saving,setSaving]=useState(false)
  const [message,setMessage]=useState('')
  useEffect(()=>{
    let active=true
    void api<State>('/alerts/commander-diagnostics').then(r=>{if(active){setState(r);setEnabled(r.enabled);setAck(r.enabled)}}).catch(()=>{if(active)setMessage('Não foi possível carregar diagnósticos.')})
    return()=>{active=false}
  },[api])
  async function save(){
    setSaving(true);setMessage('')
    try{const r=await api<State>('/alerts/commander-diagnostics',{method:'PATCH',body:JSON.stringify({enabled,acknowledge:ack})});setState(r);setEnabled(r.enabled);setMessage('Preferências salvas.')}
    catch{setMessage('Não foi possível salvar.')}
    finally{setSaving(false)}
  }
  async function refresh(){
    try{setState(await api<State>('/alerts/commander-diagnostics'));setMessage('Estado atualizado.')}
    catch{setMessage('Não foi possível atualizar.')}
  }
  return <div style={{marginTop:24}}>
    <h3>AI Commander — diagnóstico automático</h3>
    <p>Analisa novas ocorrências e envia hipóteses ao grupo. Nenhuma alteração automática de anúncios ou filas.</p>
    <label className="toggle-label"><span>Analisar ocorrências automaticamente</span><input type="checkbox" checked={enabled} disabled={!state||saving} onChange={e=>setEnabled(e.target.checked)}/></label>
    <label className="toggle-label"><span>Autorizo o envio de evidências operacionais estruturadas ao DeepSeek e de resultados ao grupo.</span><input type="checkbox" checked={ack} disabled={!state||saving||!enabled} onChange={e=>setAck(e.target.checked)}/></label>
    <p><small>Até 10 diagnósticos por dia, independentes das perguntas. Intervalo de 30 minutos por trabalho e categoria. Alertas normais continuam ativos. Histórico de 30 dias.</small></p>
    {state?.requiresRebind&&<p>Destino alterado. Confirme novamente antes de ativar.</p>}
    <p>Diagnósticos reservados hoje: {state?.usage.used??0}/{state?.usage.limit??10}</p>
    <div style={{display:'flex',gap:12,alignItems:'center'}}>
      <button type="button" className="secondary" disabled={!state||saving||(enabled&&(!ack||!state.configured))} onClick={()=>void save()}>Salvar diagnósticos</button>
      <button type="button" className="secondary" disabled={!state||saving} onClick={()=>void refresh()}>Atualizar histórico</button>
      <small role="status">{message}</small>
    </div>
    <details><summary>Últimos diagnósticos</summary><table><thead><tr><th>Evento</th><th>Trabalho</th><th>Hipótese</th><th>Análise</th><th>Entrega</th></tr></thead><tbody>{state?.history.map(h=><tr key={h.eventId}><td>{h.eventId}</td><td>{h.jobId}</td><td>{h.cause}</td><td>{h.analysisStatus}</td><td>{h.deliveryStatus}</td></tr>)}</tbody></table></details>
  </div>
}
