import { useEffect, useState } from 'react'
type Api = <T=Record<string,unknown>>(path:string,options?:RequestInit)=>Promise<T>
const categories=[
  ['schedule','Agendamentos'],['execution','Início de preenchimento'],['published','Publicações confirmadas'],
  ['review','Revisão e conflitos'],['recovery','Recuperações e alterações de perfil'],['profiles','Conexão dos perfis'],
  ['limits','Limites diários'],['expiry','Avisos de vencimento'],['daily','Resumo diário às 21h30'],
] as const
export function TelegramMonitorSettings({api}:{api:Api}){
  const [selected,setSelected]=useState<string[]>([])
  const [ready,setReady]=useState(false)
  const [saving,setSaving]=useState(false)
  const [message,setMessage]=useState('')
  useEffect(()=>{
    let active=true
    void api<{categories:string[]}>('/alerts/telegram-monitor').then(result=>{
      if(active){setSelected(result.categories);setReady(true)}
    }).catch(()=>{if(active)setMessage('Não foi possível carregar as notificações.')})
    return ()=>{active=false}
  },[api])
  async function save(){
    setSaving(true);setMessage('')
    try{
      const result=await api<{categories:string[]}>('/alerts/telegram-monitor',{method:'PATCH',body:JSON.stringify({categories:selected})})
      setSelected(result.categories);setMessage('Preferências salvas.')
    }catch{setMessage('Não foi possível salvar.')}
    finally{setSaving(false)}
  }
  return <div style={{marginTop:20}}>
    <h3>Notificações operacionais no Telegram</h3>
    <p>Ative as categorias desejadas. Usa somente o bot e o grupo salvos no banco desta empresa. Alertas críticos existentes continuam independentes.</p>
    <div className="settings-fields">
      {categories.map(([key,label])=><label className="toggle-label" key={key}>
        <span>{label}</span>
        <input type="checkbox" checked={selected.includes(key)} disabled={!ready||saving} onChange={event=>setSelected(old=>event.target.checked?[...old,key]:old.filter(item=>item!==key))}/>
      </label>)}
    </div>
    <small>Verificação periódica; horários de Brasília. Resumo no primeiro ciclo após 21h30. Sem reenvio automático de entregas incertas.</small>
    <div style={{display:'flex',gap:12,alignItems:'center',marginTop:12}}>
      <button type="button" className="secondary" disabled={!ready||saving} onClick={()=>void save()}>Salvar notificações</button>
      <small role="status">{message}</small>
    </div>
  </div>
}
