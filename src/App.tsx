import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, Bell, Car, Check, CheckCheck, ChevronDown, CircleAlert, LayoutDashboard, Laptop, Menu, Moon, MoreHorizontal, Plus, Send, Settings, ShieldCheck, Sun, Trash2, UserPlus, Users, X } from 'lucide-react'
import { OverviewView, PublicationsView, ReportsView, SettingsView } from './Views'
import VehiclesView, { type VehicleRecord } from './Vehicles'

type Vehicle = VehicleRecord & {updated?:string}
type TeamUser = { id:number; name:string; email:string; role:'admin'|'seller' }
type SocialAccount = { id:number; userId:number; label:string; platform:string; status:string; browserProfile:string; lastSeenAt?:string }

const seed: Vehicle[] = [
  { id:1, year:2022, make:'Toyota', model:'Corolla', trim:'XEi 2.0', price:119900, km:42500, seller:'Marina Costa', initials:'MC', status:'Pronto', color:'#dce8ef', updated:'há 12 min' },
  { id:2, year:2021, make:'Jeep', model:'Compass', trim:'Longitude', price:134500, km:51820, seller:'Rafael Lima', initials:'RL', status:'Publicado', color:'#dedbd3', updated:'há 38 min' },
  { id:3, year:2023, make:'Volkswagen', model:'T-Cross', trim:'Comfortline', price:128900, km:22300, seller:'Marina Costa', initials:'MC', status:'Rascunho', color:'#d9e2e6', updated:'há 1h' },
  { id:4, year:2020, make:'Honda', model:'Civic', trim:'Touring', price:139990, km:68100, seller:'Lucas Alves', initials:'LA', status:'Atenção', color:'#e7e4de', updated:'há 2h' },
  { id:5, year:2024, make:'Chevrolet', model:'Tracker', trim:'Premier', price:154900, km:8900, seller:'Rafael Lima', initials:'RL', status:'Pronto', color:'#d9e0df', updated:'há 3h' },
]

const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3333/api'
class ApiError extends Error {
  constructor(message:string,readonly status:number,readonly missing?:unknown){super(message)}
}
async function request<T>(token:string,path:string,options:RequestInit={}) {
  const response=await fetch(`${API}${path}`,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...options.headers}})
  const data=await response.json().catch(()=>({})) as {error?:string;missing?:unknown}
  if(!response.ok)throw new ApiError(data.error||'Não foi possível concluir a operação.',response.status,data.missing)
  return data as T
}
const nav = [
  ['Visão geral', LayoutDashboard], ['Veículos', Car], ['Publicações', Send], ['Equipe e contas', Users], ['Relatórios', BarChart3],
] as const

function storedStringList(key:string) {
  try { const value=JSON.parse(localStorage.getItem(key)||'[]'); return Array.isArray(value)?value.filter(item=>typeof item==='string'):[] }
  catch { return [] }
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('autoflow_token') || '')
  const [authError, setAuthError] = useState('')
  const [loading, setLoading] = useState(Boolean(token))
  const [active, setActive] = useState('Veículos')
  const [vehicles, setVehicles] = useState<Vehicle[]>(token ? [] : seed)
  const [toast, setToast] = useState('')
  const [organizationName, setOrganizationName] = useState('AutoPrime Veículos')
  const [theme, setTheme] = useState<'light'|'dark'>(() => localStorage.getItem('autoflow_theme') === 'dark' ? 'dark' : 'light')
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>(() => storedStringList('autoflow_notifications_read_ids'))
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>(() => storedStringList('autoflow_notifications_dismissed_ids'))
  const [team, setTeam] = useState<TeamUser[]>([])
  const [accounts, setAccounts] = useState<SocialAccount[]>([])

  const clearSession=useCallback((message='')=>{
    localStorage.removeItem('autoflow_token')
    setToken('');setLoading(false);setVehicles([]);setTeam([]);setAccounts([]);setAuthError(message)
  },[])

  const api=useCallback(async <T=Record<string,unknown>,>(path:string, options:RequestInit = {}):Promise<T> => {
    try{return await request<T>(token,path,options)}
    catch(error){
      if(error instanceof ApiError&&error.status===401){const message='Sua sessão expirou. Entre novamente.';clearSession(message);throw new Error(message,{cause:error})}
      if(error instanceof ApiError)throw Object.assign(error,{missing:error.missing})
      throw error
    }
  },[token,clearSession])

  const loadVehicles=useCallback(async () => {
    try{const data=await api<{vehicles:Vehicle[]}>('/vehicles');setVehicles(data.vehicles)}
    catch(error){if(token)setToast(error instanceof Error?error.message:'Não foi possível atualizar o estoque.')}
    finally{setLoading(false)}
  },[api,token])

  const loadTeam=useCallback(async () => {
    try { const data = await api<{users:TeamUser[];accounts:SocialAccount[]}>('/team'); setTeam(data.users); setAccounts(data.accounts) }
    catch (error) { setToast(error instanceof Error ? error.message : 'Erro ao carregar equipe') }
  },[api])

  const loadOrganizationName=useCallback(async () => {
    try { const data = await api<{organization:{name:string}}>('/settings'); setOrganizationName(data.organization.name) } catch { /* login flow handles invalid sessions */ }
  },[api])

  useEffect(() => {
    if(!token)return
    let active=true
    void Promise.all([
      request<{vehicles:Vehicle[]}>(token,'/vehicles'),
      request<{organization:{name:string}}>(token,'/settings'),
      request<{users:TeamUser[];accounts:SocialAccount[]}>(token,'/team'),
    ]).then(([stock,settings,teamData])=>{
      if(!active)return
      setVehicles(stock.vehicles);setOrganizationName(settings.organization.name);setTeam(teamData.users);setAccounts(teamData.accounts)
    }).catch(error=>{
      if(!active)return
      if(error instanceof ApiError&&error.status===401)clearSession('Sua sessão expirou. Entre novamente.')
      else setToast(error instanceof Error?error.message:'Não foi possível carregar os dados do painel.')
    }).finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  },[token,clearSession])

  function changeTheme(next:'light'|'dark') {
    setTheme(next); localStorage.setItem('autoflow_theme',next)
  }

  const notifications = useMemo(() => {
    const items:{id:string;title:string;detail:string;page:string;tone:string}[] = []
    const attention = vehicles.filter(v=>v.status==='Atenção').length
    const ready = vehicles.filter(v=>v.status==='Pronto').length
    const waiting = accounts.filter(a=>a.status!=='connected').length
    const soldPendingRemoval = vehicles.filter(v=>v.status==='Vendido'&&Number(v.pendingRemovalCount)>0)
    const overdue = soldPendingRemoval.filter(v=>v.soldAt&&Date.now()-new Date(v.soldAt+'Z').getTime()>24*60*60*1000)
    if (attention) items.push({id:`attention-${attention}`,title:`${attention} veículo${attention>1?'s':''} precisa${attention>1?'m':''} de atenção`,detail:'Revise os dados antes de colocar na fila.',page:'Veículos',tone:'red'})
    if (ready) items.push({id:`ready-${ready}`,title:`${ready} veículo${ready>1?'s':''} pronto${ready>1?'s':''} para publicar`,detail:'Distribua o estoque entre os perfis disponíveis.',page:'Publicações',tone:'amber'})
    if (soldPendingRemoval.length) items.push({id:`sold-removal-${soldPendingRemoval.length}-${overdue.length}`,title:`${soldPendingRemoval.length} veículo${soldPendingRemoval.length>1?'s':''} vendido${soldPendingRemoval.length>1?'s':''} aguardando remoção do anúncio`,detail:overdue.length?'Já passou de 24h: remova o anúncio no Facebook e confirme em Publicações.':'A Meta exige remover o anúncio em até 24h após a venda.',page:'Publicações',tone:overdue.length?'red':'amber'})
    if (waiting) items.push({id:`profiles-${waiting}`,title:`${waiting} perfil${waiting>1?'s':''} aguardando extensão`,detail:'Abra a extensão no Brave para confirmar a conexão.',page:'Equipe e contas',tone:'blue'})
    return items
  },[vehicles,accounts])
  const visibleNotifications = notifications.filter(item=>!dismissedNotificationIds.includes(item.id))
  const unreadCount = visibleNotifications.filter(item=>!readNotificationIds.includes(item.id)).length
  function saveRead(ids:string[]) { setReadNotificationIds(ids); localStorage.setItem('autoflow_notifications_read_ids',JSON.stringify(ids)) }
  function saveDismissed(ids:string[]) { setDismissedNotificationIds(ids); localStorage.setItem('autoflow_notifications_dismissed_ids',JSON.stringify(ids)) }
  function markNotificationRead(id:string) { if(!readNotificationIds.includes(id)) saveRead([...readNotificationIds,id]) }
  function markAllNotificationsRead() { saveRead([...new Set([...readNotificationIds,...visibleNotifications.map(item=>item.id)])]) }
  function dismissNotification(id:string) { if(!dismissedNotificationIds.includes(id)) saveDismissed([...dismissedNotificationIds,id]) }
  function dismissAllNotifications() { saveDismissed([...new Set([...dismissedNotificationIds,...visibleNotifications.map(item=>item.id)])]) }

  async function addUser(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget)
    try {
      await api('/team/users',{method:'POST',body:JSON.stringify(Object.fromEntries(form))}); await loadTeam()
      setToast('Vendedor adicionado'); setTimeout(()=>setToast(''),2500);return true
    } catch (error) { setToast(error instanceof Error ? error.message : 'Erro ao adicionar usuário'); setTimeout(()=>setToast(''),3000);return false }
  }

  async function addAccount(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget)
    try {
      await api('/social-accounts',{method:'POST',body:JSON.stringify({userId:Number(form.get('userId')),label:form.get('label'),browserProfile:form.get('browserProfile')})}); await loadTeam()
      setToast('Perfil local associado'); setTimeout(()=>setToast(''),2500);return true
    } catch (error) { setToast(error instanceof Error ? error.message : 'Erro ao associar perfil'); setTimeout(()=>setToast(''),3000);return false }
  }

  async function login(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setAuthError(''); setLoading(true)
    const form = new FormData(e.currentTarget)
    try {
      const response = await fetch(`${API}/auth/login`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:form.get('email'),password:form.get('password')})})
      const data = await response.json(); if (!response.ok) throw new Error(data.error)
      localStorage.setItem('autoflow_token', data.token); setToken(data.token)
    } catch (error) { setAuthError(error instanceof Error ? error.message : 'Falha no acesso.'); setLoading(false) }
  }

  function logout() { clearSession() }


  if (!token) return <Login onSubmit={login} error={authError} loading={loading} theme={theme}/>
  if (loading) return <div className={`loading ${theme==='dark'?'theme-dark':''}`}><span/><p>Carregando seu estoque...</p></div>

  return <div className={`app-shell ${theme==='dark'?'theme-dark':''}`}>
    <aside className={`sidebar ${mobileMenuOpen?'mobile-open':''}`}>
      <div className="brand"><span className="brand-mark"><Car size={22}/></span><span>AutoFlow</span></div>
      <button className="workspace" onClick={()=>{setActive('Configurações');setMobileMenuOpen(false)}}><span className="workspace-logo">{organizationName.split(' ').map(n=>n[0]).slice(0,2).join('')}</span><div><small>Empresa</small><strong>{organizationName}</strong></div><ChevronDown size={16}/></button>
      <nav>{nav.map(([label, Icon]) => <button key={label} className={active===label?'active':''} onClick={()=>{setActive(label);setMobileMenuOpen(false)}}><Icon size={19}/>{label}{label==='Publicações'&&vehicles.filter(v=>v.status==='Pronto').length>0&&<span className="count">{vehicles.filter(v=>v.status==='Pronto').length}</span>}</button>)}</nav>
      <div className="sidebar-foot"><button className={active==='Configurações'?'active':''} onClick={()=>{setActive('Configurações');setMobileMenuOpen(false)}}><Settings size={19}/>Configurações</button><div className="profile"><span>DC</span><div><strong>Daniel Costa</strong><small>Administrador</small></div><button className="logout" onClick={logout} title="Sair"><MoreHorizontal size={18}/></button></div></div>
    </aside>
    {mobileMenuOpen&&<button className="mobile-overlay" onClick={()=>setMobileMenuOpen(false)} aria-label="Fechar menu"/>}

    <main>
      <header><button className="mobile-menu" onClick={()=>setMobileMenuOpen(true)} aria-label="Abrir menu"><Menu/></button><div className="crumb"><span>AutoFlow</span><b>/</b><strong>{active}</strong></div><div className="header-actions"><button className="theme-quick" onClick={()=>changeTheme(theme==='light'?'dark':'light')} aria-label={theme==='light'?'Ativar tema escuro':'Ativar tema claro'} title={theme==='light'?'Tema escuro':'Tema claro'}>{theme==='light'?<Moon size={17}/>:<Sun size={17}/>}</button><div className="notification-wrap"><button className="icon-btn" onClick={()=>setNotificationsOpen(open=>!open)} aria-label="Abrir notificações" aria-expanded={notificationsOpen}><Bell size={19}/>{unreadCount>0&&<span className="notification-count">{unreadCount}</span>}</button>{notificationsOpen&&<NotificationCenter notifications={visibleNotifications} readIds={readNotificationIds} onClose={()=>setNotificationsOpen(false)} onReadAll={markAllNotificationsRead} onDismiss={dismissNotification} onDismissAll={dismissAllNotifications} onNavigate={(id,page)=>{markNotificationRead(id);setActive(page);setNotificationsOpen(false)}}/>}</div><span className="sync"><i/>Sincronizado agora</span></div></header>
      {active === 'Visão geral' ? <OverviewView api={api} vehicles={vehicles} navigate={setActive}/> : active === 'Publicações' ? <PublicationsView api={api} vehicles={vehicles} reload={loadVehicles}/> : active === 'Equipe e contas' ? <TeamView team={team} accounts={accounts} onAddUser={addUser} onAddAccount={addAccount}/> : active === 'Relatórios' ? <ReportsView api={api} vehicles={vehicles}/> : active === 'Configurações' ? <SettingsView api={api} onSaved={loadOrganizationName} theme={theme} onThemeChange={changeTheme}/> : <VehiclesView api={api} vehicles={vehicles} accounts={accounts} reload={loadVehicles} notify={message=>{setToast(message);setTimeout(()=>setToast(''),3000)}}/>}
    </main>
    {toast&&<div className="toast"><Check size={17}/>{toast}</div>}
  </div>
}

function NotificationCenter({notifications,readIds,onClose,onReadAll,onDismiss,onDismissAll,onNavigate}:{notifications:{id:string;title:string;detail:string;page:string;tone:string}[];readIds:string[];onClose:()=>void;onReadAll:()=>void;onDismiss:(id:string)=>void;onDismissAll:()=>void;onNavigate:(id:string,page:string)=>void}) {
  const unread = notifications.filter(item=>!readIds.includes(item.id)).length
  return <div className="notification-panel">
    <div className="notification-head"><div><strong>Notificações</strong><span>{notifications.length ? `${unread} não lida${unread===1?'':'s'}` : 'Tudo em ordem'}</span></div><button onClick={onClose} aria-label="Fechar notificações"><X/></button></div>
    <div className="notification-actions"><button onClick={onReadAll} disabled={!unread}><CheckCheck/>Marcar todas como lidas</button><button onClick={onDismissAll} disabled={!notifications.length}><Trash2/>Limpar todas</button></div>
    <div className="notification-list">{notifications.map(item=><article key={item.id} className={readIds.includes(item.id)?'read':''}><button className="notification-main" onClick={()=>onNavigate(item.id,item.page)}><i className={item.tone}/><div><strong>{item.title}</strong><span>{item.detail}</span></div><ChevronDown className="notification-arrow"/></button><button className="notification-delete" onClick={()=>onDismiss(item.id)} aria-label={`Excluir notificação: ${item.title}`} title="Excluir notificação"><Trash2/></button></article>)}{!notifications.length&&<div className="notification-empty"><Check/><strong>Nenhuma pendência</strong><span>Você receberá avisos importantes aqui.</span></div>}</div>
    <div className="notification-foot">Atualizado com os dados do painel</div>
  </div>
}

function TeamView({team,accounts,onAddUser,onAddAccount}:{team:TeamUser[];accounts:SocialAccount[];onAddUser:(e:React.FormEvent<HTMLFormElement>)=>Promise<boolean>;onAddAccount:(e:React.FormEvent<HTMLFormElement>)=>Promise<boolean>}) {
  const [modal,setModal] = useState<'user'|'account'|null>(null)
  return <section className="content team-page">
    <div className="title-row"><div><h1>Equipe e contas</h1><p>Defina quem publica e qual perfil local do Brave cada pessoa utiliza.</p></div><div className="title-actions"><button className="secondary" onClick={()=>setModal('account')}><Laptop size={17}/>Associar perfil</button><button className="primary" onClick={()=>setModal('user')}><UserPlus size={18}/>Adicionar vendedor</button></div></div>
    <div className="security-note"><ShieldCheck/><div><strong>Sessões permanecem no computador do vendedor</strong><p>O AutoFlow armazena somente o nome do perfil do navegador. Senhas, cookies e tokens do Facebook não são enviados ao servidor.</p></div></div>
    <div className="team-grid">
      <article className="team-panel"><div className="panel-heading"><div><h2>Pessoas</h2><span>{team.length} membros</span></div></div><div className="people-list">{team.map(user=><div className="person-row" key={user.id}><span className="person-avatar">{user.name.split(' ').map(n=>n[0]).slice(0,2).join('')}</span><div><strong>{user.name}</strong><small>{user.email}</small></div><span className={`role ${user.role}`}>{user.role==='admin'?'Administrador':'Vendedor'}</span></div>)}</div></article>
      <article className="team-panel"><div className="panel-heading"><div><h2>Perfis de publicação</h2><span>{accounts.length} associados</span></div><button className="small-add" onClick={()=>setModal('account')}><Plus size={16}/></button></div>{accounts.length ? <div className="account-list">{accounts.map(account=>{const owner=team.find(u=>u.id===account.userId);return <div className="account-card" key={account.id}><span className="browser-icon"><Laptop/></span><div><strong>{account.label}</strong><small>{account.browserProfile} · {owner?.name||'Sem responsável'}</small></div><span className="connection"><i/>Aguardando extensão</span></div>})}</div>:<div className="account-empty"><Laptop/><h3>Nenhum perfil associado</h3><p>Cadastre o perfil do Brave usado por cada vendedor. A conexão será confirmada pela extensão.</p><button className="secondary" onClick={()=>setModal('account')}>Associar primeiro perfil</button></div>}</article>
    </div>
    {modal&&<div className="overlay" onMouseDown={()=>setModal(null)}><aside className="drawer" onMouseDown={e=>e.stopPropagation()}><button className="close" onClick={()=>setModal(null)}><X/></button>{modal==='user'?<><span className="eyebrow">NOVA PESSOA</span><h2>Adicionar vendedor</h2><p>Crie um acesso individual. A senha é temporária e deve ser enviada ao vendedor por um canal seguro.</p><form onSubmit={async e=>{if(await onAddUser(e))setModal(null)}}><label>Nome completo<input name="name" required/></label><label>E-mail<input name="email" type="email" required/></label><label>Senha temporária<input name="password" type="password" minLength={8} required/></label><label>Função<select name="role"><option value="seller">Vendedor</option><option value="admin">Administrador</option></select></label><button className="primary">Criar acesso</button></form></>:<><span className="eyebrow">PERFIL LOCAL</span><h2>Associar perfil do Brave</h2><p>Use um perfil separado para cada pessoa. Não informe e-mail, senha ou cookie do Facebook.</p><form onSubmit={async e=>{if(await onAddAccount(e))setModal(null)}}><label>Identificação<input name="label" placeholder="Ex.: Facebook — Marina" required/></label><label>Responsável<select name="userId" required><option value="">Selecione</option>{team.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label><label>Nome do perfil no Brave<input name="browserProfile" placeholder="Ex.: Perfil 2" required/></label><button className="primary">Associar perfil</button></form></>}</aside></div>}
  </section>
}

function Login({onSubmit,error,loading,theme}:{onSubmit:(e:React.FormEvent<HTMLFormElement>)=>void,error:string,loading:boolean,theme:'light'|'dark'}) {
  return <div className={`login-page ${theme==='dark'?'theme-dark':''}`}><section className="login-aside"><div className="brand light"><span className="brand-mark"><Car size={22}/></span><span>AutoFlow</span></div><div><span className="eyebrow light-text">OPERAÇÃO MULTICONTA</span><h1>Seu estoque pronto para vender, em um só lugar.</h1><p>Organize veículos, vendedores e filas de publicação sem compartilhar credenciais pessoais.</p></div><small>Ambiente local seguro para desenvolvimento</small></section><main className="login-main"><form className="login-card" onSubmit={onSubmit}><span className="login-logo"><Car/></span><h2>Bem-vindo</h2><p>Acesse o painel da sua empresa.</p>{error&&<div className="auth-error"><CircleAlert size={16}/>{error}</div>}<label>E-mail<input name="email" type="email" autoComplete="email" required/></label><label>Senha<input name="password" type="password" autoComplete="current-password" required/></label><button className="primary" disabled={loading}>{loading?'Entrando...':'Entrar no painel'}</button><small>Use as credenciais definidas na configuração inicial.</small></form></main></div>
}
