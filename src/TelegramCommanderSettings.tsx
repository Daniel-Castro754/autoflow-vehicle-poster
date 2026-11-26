import './commander-settings.css'
import { useEffect, useState } from 'react'
type Api = <T=Record<string,unknown>>(path:string,options?:RequestInit)=>Promise<T>
type State={enabled:boolean;aiEnabled:boolean;memoryEnabled:boolean;memoryCount:number;usage:{day:string;used:number;limit:number};userIds:string[];configured:boolean;requiresRebind:boolean;lastPollAt:string|null;lastStatus:string}
export function TelegramCommanderSettings({api}:{api:Api}){
  const [state,setState]=useState<State|null>(null)
  const [enabled,setEnabled]=useState(false)
  const [aiEnabled,setAiEnabled]=useState(false)
  const [aiAck,setAiAck]=useState(false)
  const [memoryEnabled,setMemoryEnabled]=useState(false)
  const [memoryAck,setMemoryAck]=useState(false)
  const [userIds,setUserIds]=useState('')
  const [ack,setAck]=useState(false)
  const [saving,setSaving]=useState(false)
  const [message,setMessage]=useState('')
  useEffect(()=>{
    let active=true
    void api<State>('/alerts/telegram-commander').then(result=>{
      if(active){setState(result);setEnabled(result.enabled);setUserIds(result.userIds.join(', '));setAck(result.enabled);setAiEnabled(result.aiEnabled);setAiAck(result.aiEnabled);setMemoryEnabled(result.memoryEnabled);setMemoryAck(result.memoryEnabled)}
    }).catch(()=>{if(active)setMessage('Não foi possível carregar o receptor.')})
    return ()=>{active=false}
  },[api])
  async function save(){
    setSaving(true);setMessage('')
    try{
      const result=await api<State>('/alerts/telegram-commander',{method:'PATCH',body:JSON.stringify({enabled,userIds:userIds.split(/[\s,;]+/).filter(Boolean),acknowledgeGroup:ack,aiEnabled:enabled&&aiEnabled,acknowledgeDeepseek:aiAck,memoryEnabled:enabled&&aiEnabled&&memoryEnabled,acknowledgeMemory:memoryAck})})
      setState(result);setEnabled(result.enabled);setAiEnabled(result.aiEnabled);setMemoryEnabled(result.memoryEnabled);setUserIds(result.userIds.join(', '));setMessage('Configuração salva.')
    }catch{setMessage('Não foi possível salvar. Verifique o grupo e os IDs autorizados.')}
    finally{setSaving(false)}
  }
  async function clearMemory(){
    if(!window.confirm('Limpar as referências de todos os usuários desta empresa? Backups e histórico operacional não serão alterados.'))return
    setSaving(true)
    try{await api('/alerts/commander-memory/clear',{method:'POST',body:JSON.stringify({confirm:true})});setState(await api<State>('/alerts/telegram-commander'));setMessage('Memória local limpa.')}
    catch{setMessage('Não foi possível limpar a memória.')}
    finally{setSaving(false)}
  }
  async function refresh(){
    try{setState(await api<State>('/alerts/telegram-commander'));setMessage('Estado atualizado.')}
    catch{setMessage('Não foi possível consultar o estado.')}
  }
  return <section className="commander-section">
    <div className="commander-heading"><h3>Telegram e IA</h3><span className="commander-metric">Receptor: {state ? (state.enabled ? "Ligado" : "Desligado") : "Carregando"}</span></div>
    <p>Consulta somente leitura. Usa o bot e grupo salvos. O receptor é independente das notificações.</p>
    <div className="commander-grid"><div className="commander-group commander-group-wide"><h4>Conexão e acesso</h4>
    <label className="toggle-label"><span>Receber comandos do Telegram</span><input type="checkbox" checked={enabled} disabled={!state||saving} onChange={e=>setEnabled(e.target.checked)}/></label>
    <label><span>IDs de usuários autorizados (separados por vírgula)</span>
      <input value={userIds} onChange={e=>setUserIds(e.target.value)} placeholder="Envie /meu_id no grupo para descobrir seu ID" disabled={!state||saving}/>
    </label>
    <label className="toggle-label"><span>Entendo que as respostas podem ser vistas por todos os membros do grupo.</span><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} disabled={!state||saving}/></label>
    <details><summary>Como vincular o Telegram</summary><p><small>Para vincular: salve com o receptor ligado e sem IDs, envie /meu_id@NomeDoBot no grupo e depois salve seu ID. Somente usuários autorizados podem consultar /status e /ajuda. Não é necessário desativar a privacidade do bot.</small></p></details></div>
    <div className="commander-group"><div className="commander-heading"><h4>DeepSeek</h4><span className="commander-metric">{state?.usage?.used??0}/{state?.usage?.limit??20} hoje</span></div>
    <label className="toggle-label"><span>Responder perguntas com DeepSeek (somente leitura)</span><input type="checkbox" checked={enabled&&aiEnabled} disabled={!state||saving||!enabled} onChange={e=>setAiEnabled(e.target.checked)}/></label>
    <label className="toggle-label"><span>Autorizo o envio das perguntas e dos dados operacionais selecionados à API DeepSeek.</span><input type="checkbox" checked={aiAck} disabled={!state||saving||!enabled||!aiEnabled} onChange={e=>setAiAck(e.target.checked)}/></label>
    <details><summary>Comandos e limites da IA</summary><p><small>Use /ia@NomeDoBot seguido da pergunta, mencione @NomeDoBot no início ou responda diretamente ao bot. Use /menu@NomeDoBot para abrir os atalhos de consulta. Não envie senhas, chaves, dados pessoais ou logs brutos. Limite de 20 perguntas por dia (Brasília), até 3 chamadas de IA por pergunta.</small></p></details>
    </div>
    <div className="commander-group"><div className="commander-heading"><h4>Memória</h4><span className="commander-metric">{state?.memoryCount??0} referências</span></div>
    <label className="toggle-label"><span>Memória de referências de consultas</span><input type="checkbox" checked={enabled&&aiEnabled&&memoryEnabled} disabled={!state||saving||!enabled||!aiEnabled} onChange={e=>setMemoryEnabled(e.target.checked)}/></label>
    <label className="toggle-label"><span>Autorizo armazenar e reutilizar referências de consultas no DeepSeek por até 30 dias.</span><input type="checkbox" checked={memoryAck} disabled={!state||saving||!enabled||!aiEnabled||!memoryEnabled} onChange={e=>setMemoryAck(e.target.checked)}/></label>
    <details><summary>Retenção e limpeza da memória</summary><p><small>Até 6 consultas respondidas por usuário, sem texto de conversa. Alterar a autorização ou desativar a memória limpa as referências. Use /limpar_memoria para limpar as suas.</small></p></details>

    <button type="button" className="secondary" disabled={!state||saving} onClick={()=>void clearMemory()}>Limpar memória da empresa</button></div></div>
    <div className="commander-state"><small>Estado: {state?.lastStatus||'carregando'} {state?.lastPollAt?' · '+new Date(state.lastPollAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):''}</small></div>
    {state?.requiresRebind&&<p>O destino mudou. Revise a autorização e salve novamente.</p>}
    <div className="commander-actions">
      <button type="button" className="secondary" disabled={!state||saving||(enabled&&(!ack||!state.configured||(aiEnabled&&(!aiAck||!userIds.trim()||(memoryEnabled&&!memoryAck)))))} onClick={()=>void save()}>Salvar receptor</button>
      <button type="button" className="secondary" disabled={!state||saving} onClick={()=>void refresh()}>Atualizar estado</button>
      <small role="status">{message}</small>
    </div>
  </section>
}
