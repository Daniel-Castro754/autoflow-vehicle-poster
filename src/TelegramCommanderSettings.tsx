import { useEffect, useState } from 'react'
type Api = <T=Record<string,unknown>>(path:string,options?:RequestInit)=>Promise<T>
type State={enabled:boolean;userIds:string[];configured:boolean;requiresRebind:boolean;lastPollAt:string|null;lastStatus:string}
export function TelegramCommanderSettings({api}:{api:Api}){
  const [state,setState]=useState<State|null>(null)
  const [enabled,setEnabled]=useState(false)
  const [userIds,setUserIds]=useState('')
  const [ack,setAck]=useState(false)
  const [saving,setSaving]=useState(false)
  const [message,setMessage]=useState('')
  useEffect(()=>{
    let active=true
    void api<State>('/alerts/telegram-commander').then(result=>{
      if(active){setState(result);setEnabled(result.enabled);setUserIds(result.userIds.join(', '));setAck(result.enabled)}
    }).catch(()=>{if(active)setMessage('Não foi possível carregar o receptor.')})
    return ()=>{active=false}
  },[api])
  async function save(){
    setSaving(true);setMessage('')
    try{
      const result=await api<State>('/alerts/telegram-commander',{method:'PATCH',body:JSON.stringify({enabled,userIds:userIds.split(/[\s,;]+/).filter(Boolean),acknowledgeGroup:ack})})
      setState(result);setEnabled(result.enabled);setUserIds(result.userIds.join(', '));setMessage('Configuração salva.')
    }catch{setMessage('Não foi possível salvar. Verifique o grupo e os IDs autorizados.')}
    finally{setSaving(false)}
  }
  async function refresh(){
    try{setState(await api<State>('/alerts/telegram-commander'));setMessage('Estado atualizado.')}
    catch{setMessage('Não foi possível consultar o estado.')}
  }
  return <div style={{marginTop:24}}>
    <h3>AI Commander — comandos pelo Telegram</h3>
    <p>Consulta somente leitura. Usa o bot e grupo salvos. O receptor é independente das notificações.</p>
    <label className="toggle-label"><span>Receber comandos do Telegram</span><input type="checkbox" checked={enabled} disabled={!state||saving} onChange={e=>setEnabled(e.target.checked)}/></label>
    <label><span>IDs de usuários autorizados (separados por vírgula)</span>
      <input value={userIds} onChange={e=>setUserIds(e.target.value)} placeholder="Envie /meu_id no grupo para descobrir seu ID" disabled={!state||saving}/>
    </label>
    <label className="toggle-label"><span>Entendo que as respostas podem ser vistas por todos os membros do grupo.</span><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} disabled={!state||saving}/></label>
    <p><small>Para vincular: salve com o receptor ligado e sem IDs, envie /meu_id@NomeDoBot no grupo e depois salve seu ID. Somente usuários autorizados podem consultar /status e /ajuda. Não é necessário desativar a privacidade do bot.</small></p>
    <small>Estado: {state?.lastStatus||'carregando'} {state?.lastPollAt?' · '+new Date(state.lastPollAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):''}</small>
    {state?.requiresRebind&&<p>O destino mudou. Revise a autorização e salve novamente.</p>}
    <div style={{display:'flex',gap:12,alignItems:'center',marginTop:12}}>
      <button type="button" className="secondary" disabled={!state||saving||(enabled&&(!ack||!state.configured))} onClick={()=>void save()}>Salvar receptor</button>
      <button type="button" className="secondary" disabled={!state||saving} onClick={()=>void refresh()}>Atualizar estado</button>
      <small role="status">{message}</small>
    </div>
  </div>
}
