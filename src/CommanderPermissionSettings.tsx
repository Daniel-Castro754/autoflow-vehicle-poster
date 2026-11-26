import {useEffect,useState} from 'react'
type Api=<T=Record<string,unknown>>(path:string,options?:RequestInit)=>Promise<T>
type Grant={userId:string;action:string}
type State={enabled:boolean;requiresRebind:boolean;userIds:string[];grants:Grant[];catalog:Array<{name:string;description:string;mode:string}>;requests:Array<{id:number;userId:string;action:string;jobId:number;status:string;createdAt:number;mode:string;scheduledAt:string|null}>}
const labels:Record<string,string>={pending:'Pendente',executed:'Executada',validated_only:'Validada sem execução',rejected:'Recusada',expired:'Vencida',stale:'Estado alterado',revoked:'Revogada'}
export function CommanderPermissionSettings({api}:{api:Api}){
  const [state,setState]=useState<State|null>(null)
  const [enabled,setEnabled]=useState(false)
  const [grants,setGrants]=useState<Grant[]>([])
  const [ack,setAck]=useState(false)
  const [liveAck,setLiveAck]=useState(false)
  const hasLive=grants.some(g=>g.action!=='pausar_trabalho')
  const [saving,setSaving]=useState(false)
  const [message,setMessage]=useState('')
  const load=(r:State)=>{setState(r);setEnabled(r.enabled);setGrants(r.grants);setAck(r.enabled);setLiveAck(r.enabled&&r.grants.some(g=>g.action!=='pausar_trabalho'))}
  useEffect(()=>{
    let active=true
    void api<State>('/alerts/commander-permissions').then(r=>{if(active)load(r)}).catch(()=>{if(active)setMessage('Não foi possível carregar permissões.')})
    return()=>{active=false}
  },[api])
  async function save(){
    setSaving(true);setMessage('')
    try{load(await api<State>('/alerts/commander-permissions',{method:'PATCH',body:JSON.stringify({enabled,grants:enabled?grants:[],acknowledge:ack,acknowledgeLive:liveAck})}));setMessage('Permissões salvas.')}
    catch{setMessage('Não foi possível salvar. Confira os usuários e as permissões.')}
    finally{setSaving(false)}
  }
  async function refresh(){
    try{load(await api<State>('/alerts/commander-permissions'));setMessage('Permissões e histórico atualizados.')}
    catch{setMessage('Não foi possível atualizar.')}
  }
  return <div style={{marginTop:24}}>
    <h3>AI Commander — permissões e autorizações</h3>
    <p>Operações reais limitadas à fila local e separadas da demonstração. Cada execução exige nova confirmação. Nenhum comando publica ou retira anúncios do Facebook.</p>
    <label className="toggle-label"><span>Habilitar solicitações de autorização</span><input type="checkbox" checked={enabled} disabled={!state||saving} onChange={e=>setEnabled(e.target.checked)}/></label>
    {state?.requiresRebind&&<p>O receptor mudou. Autorize novamente após revisar os usuários.</p>}
    <table><thead><tr><th>Usuário Telegram</th><th>Ferramenta autorizada</th></tr></thead><tbody>
      {state?.userIds.flatMap(userId=>state.catalog.map(tool=><tr key={userId+':'+tool.name}><td>{userId}</td><td><label><input type="checkbox" disabled={!enabled||saving} checked={grants.some(g=>g.userId===userId&&g.action===tool.name)} onChange={e=>setGrants(old=>e.target.checked?[...old,{userId,action:tool.name}]:old.filter(g=>g.userId!==userId||g.action!==tool.name))}/>{tool.description}</label></td></tr>))}
    </tbody></table>
    <label className="toggle-label"><span>Confirmo os usuários e as ferramentas selecionadas.</span><input type="checkbox" checked={ack} disabled={!enabled||saving||!state} onChange={e=>setAck(e.target.checked)}/></label>
    {hasLive&&<label className="toggle-label"><span>Autorizo operações reais na fila, após confirmação individual.</span><input type="checkbox" checked={liveAck} disabled={!enabled||saving} onChange={e=>setLiveAck(e.target.checked)}/></label>}
    <p><small>Operações reais: /pausar ID, /adiar ID AAAA-MM-DDTHH:MM-03:00, /cancelar_trabalho ID. Somente trabalhos pendentes nunca iniciados. Use /solicitar_pausa ID para demonstração; e depois /autorizar ou /recusar com o código recebido. Validade de 5 minutos, decisão apenas pelo solicitante. Alterar permissões invalida propostas pendentes. Histórico de 90 dias.</small></p>
    <div style={{display:'flex',gap:12,alignItems:'center'}}>
      <button type="button" className="secondary" disabled={!state||saving||(enabled&&(!ack||!grants.length||(hasLive&&!liveAck)))} onClick={()=>void save()}>Salvar permissões</button>
      <button type="button" className="secondary" disabled={!state||saving} onClick={()=>void refresh()}>Atualizar permissões e histórico</button>
      <small role="status">{message}</small>
    </div>
    <details><summary>Últimas solicitações</summary><table><thead><tr><th>Trabalho</th><th>Operação</th><th>Usuário</th><th>Estado</th><th>Data</th></tr></thead><tbody>{state?.requests.map(r=><tr key={r.id}><td>#{r.jobId}</td><td>{r.action}{r.scheduledAt?' · '+new Date(r.scheduledAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):''}</td><td>{r.userId}</td><td>{labels[r.status]||r.status}</td><td>{new Date(r.createdAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}</td></tr>)}</tbody></table></details>
  </div>
}
