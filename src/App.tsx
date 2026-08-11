import { useEffect, useMemo, useState } from 'react'
import { BarChart3, Bell, Building2, Car, Check, ChevronDown, CircleAlert, Clock3, LayoutDashboard, Laptop, Menu, Moon, MoreHorizontal, Plus, Search, Send, Settings, ShieldCheck, Sun, UserPlus, Users, X } from 'lucide-react'
import { OverviewView, PublicationsView, ReportsView, SettingsView } from './Views'
import VehiclesView, { type VehicleRecord } from './Vehicles'

type Status = 'Pronto' | 'Publicado' | 'Rascunho' | 'Atenção'
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

const money = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL', maximumFractionDigits:0 })
const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3333/api'
const nav = [
  ['Visão geral', LayoutDashboard], ['Veículos', Car], ['Publicações', Send], ['Equipe e contas', Users], ['Relatórios', BarChart3],
] as const

function Badge({status}:{status:Status}) {
  const icon = status === 'Publicado' ? <Check size={13}/> : status === 'Atenção' ? <CircleAlert size={13}/> : status === 'Rascunho' ? <Clock3 size={13}/> : <span className="dot"/>
  return <span className={`badge ${status.toLowerCase().replace('ç','c')}`}>{icon}{status}</span>
}

function CarThumb({color}:{color:string}) {
  return <div className="car-thumb" style={{background:color}}><Car size={30} strokeWidth={1.4}/></div>
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
  const [readSignature, setReadSignature] = useState(() => localStorage.getItem('autoflow_notifications_read') || '')
  const [team, setTeam] = useState<TeamUser[]>([])
  const [accounts, setAccounts] = useState<SocialAccount[]>([])

  async function api(path:string, options:RequestInit = {}) {
    const response = await fetch(`${API}${path}`, { ...options, headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`, ...options.headers} })
    const data = await response.json()
    if (!response.ok) throw Object.assign(new Error(data.error || 'Não foi possível concluir a operação.'), {missing: data.missing})
    return data
  }

  async function loadVehicles(activeToken = token) {
    const response = await fetch(`${API}/vehicles`, { headers:{Authorization:`Bearer ${activeToken}`} })
    if (response.status === 401) { localStorage.removeItem('autoflow_token'); setToken(''); setLoading(false); return }
    const data = await response.json(); setVehicles(data.vehicles); setLoading(false)
  }

  useEffect(() => { if (token) loadVehicles() }, [token])
  useEffect(() => { if (token) loadOrganizationName() }, [token])
  useEffect(() => { if (token) loadTeam() }, [token])

  async function loadTeam() {
    try { const data = await api('/team'); setTeam(data.users); setAccounts(data.accounts) }
    catch (error) { setToast(error instanceof Error ? error.message : 'Erro ao carregar equipe') }
  }

  async function loadOrganizationName() {
    try { const data = await api('/settings'); setOrganizationName(data.organization.name) } catch { /* login flow handles invalid sessions */ }
  }

  function changeTheme(next:'light'|'dark') {
    setTheme(next); localStorage.setItem('autoflow_theme',next)
  }

  const notifications = useMemo(() => {
    const items:{id:string;title:string;detail:string;page:string;tone:string}[] = []
    const attention = vehicles.filter(v=>v.status==='Atenção').length
    const ready = vehicles.filter(v=>v.status==='Pronto').length
    const waiting = accounts.filter(a=>a.status!=='connected').length
    if (attention) items.push({id:`attention-${attention}`,title:`${attention} veículo${attention>1?'s':''} precisa${attention>1?'m':''} de atenção`,detail:'Revise os dados antes de colocar na fila.',page:'Veículos',tone:'red'})
    if (ready) items.push({id:`ready-${ready}`,title:`${ready} veículo${ready>1?'s':''} pronto${ready>1?'s':''} para publicar`,detail:'Distribua o estoque entre os perfis disponíveis.',page:'Publicações',tone:'amber'})
    if (waiting) items.push({id:`profiles-${waiting}`,title:`${waiting} perfil${waiting>1?'s':''} aguardando extensão`,detail:'Abra a extensão no Brave para confirmar a conexão.',page:'Equipe e contas',tone:'blue'})
    return items
  },[vehicles,accounts])
  const notificationSignature = notifications.map(n=>n.id).join('|')
  const unreadCount = notificationSignature && notificationSignature !== readSignature ? notifications.length : 0
  function toggleNotifications() {
    const next = !notificationsOpen; setNotificationsOpen(next)
    if (next) { setReadSignature(notificationSignature); localStorage.setItem('autoflow_notifications_read',notificationSignature) }
  }

  async function addUser(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget)
    try {
      await api('/team/users',{method:'POST',body:JSON.stringify(Object.fromEntries(form))}); e.currentTarget.reset(); await loadTeam()
      setToast('Vendedor adicionado'); setTimeout(()=>setToast(''),2500)
    } catch (error) { setToast(error instanceof Error ? error.message : 'Erro ao adicionar usuário'); setTimeout(()=>setToast(''),3000) }
  }

  async function addAccount(e:React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget)
    try {
      await api('/social-accounts',{method:'POST',body:JSON.stringify({userId:Number(form.get('userId')),label:form.get('label'),browserProfile:form.get('browserProfile')})}); e.currentTarget.reset(); await loadTeam()
      setToast('Perfil local associado'); setTimeout(()=>setToast(''),2500)
    } catch (error) { setToast(error instanceof Error ? error.message : 'Erro ao associar perfil'); setTimeout(()=>setToast(''),3000) }
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

  function logout() { localStorage.removeItem('autoflow_token'); setToken(''); setVehicles([]) }


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
      <header><button className="mobile-menu" onClick={()=>setMobileMenuOpen(true)} aria-label="Abrir menu"><Menu/></button><div className="crumb"><span>AutoFlow</span><b>/</b><strong>{active}</strong></div><div className="header-actions"><button className="theme-quick" onClick={()=>changeTheme(theme==='light'?'dark':'light')} aria-label={theme==='light'?'Ativar tema escuro':'Ativar tema claro'} title={theme==='light'?'Tema escuro':'Tema claro'}>{theme==='light'?<Moon size={17}/>:<Sun size={17}/>}</button><div className="notification-wrap"><button className="icon-btn" onClick={toggleNotifications} aria-label="Abrir notificações" aria-expanded={notificationsOpen}><Bell size={19}/>{unreadCount>0&&<span className="notification-count">{unreadCount}</span>}</button>{notificationsOpen&&<NotificationCenter notifications={notifications} onClose={()=>setNotificationsOpen(false)} onNavigate={page=>{setActive(page);setNotificationsOpen(false)}}/>}</div><span className="sync"><i/>Sincronizado agora</span></div></header>
      {active === 'Visão geral' ? <OverviewView api={api} vehicles={vehicles} navigate={setActive}/> : active === 'Publicações' ? <PublicationsView api={api} vehicles={vehicles}/> : active === 'Equipe e contas' ? <TeamView team={team} accounts={accounts} onAddUser={addUser} onAddAccount={addAccount}/> : active === 'Relatórios' ? <ReportsView api={api} vehicles={vehicles}/> : active === 'Configurações' ? <SettingsView api={api} onSaved={loadOrganizationName} theme={theme} onThemeChange={changeTheme}/> : <VehiclesView api={api} vehicles={vehicles} accounts={accounts} reload={loadVehicles} notify={message=>{setToast(message);setTimeout(()=>setToast(''),3000)}}/>}
    </main>
    {toast&&<div className="toast"><Check size={17}/>{toast}</div>}
  </div>
}

function NotificationCenter({notifications,onClose,onNavigate}:{notifications:{id:string;title:string;detail:string;page:string;tone:string}[];onClose:()=>void;onNavigate:(page:string)=>void}) {
  return <div className="notification-panel"><div className="notification-head"><div><strong>Notificações</strong><span>{notifications.length ? 'Atualizações da operação' : 'Tudo em ordem'}</span></div><button onClick={onClose} aria-label="Fechar notificações"><X/></button></div><div className="notification-list">{notifications.map(item=><button key={item.id} onClick={()=>onNavigate(item.page)}><i className={item.tone}/><div><strong>{item.title}</strong><span>{item.detail}</span></div><ChevronDown className="notification-arrow"/></button>)}{!notifications.length&&<div className="notification-empty"><Check/><strong>Nenhuma pendência</strong><span>Você receberá avisos importantes aqui.</span></div>}</div><div className="notification-foot">Atualizado com os dados do painel</div></div>
}

function TeamView({team,accounts,onAddUser,onAddAccount}:{team:TeamUser[];accounts:SocialAccount[];onAddUser:(e:React.FormEvent<HTMLFormElement>)=>void;onAddAccount:(e:React.FormEvent<HTMLFormElement>)=>void}) {
  const [modal,setModal] = useState<'user'|'account'|null>(null)
  return <section className="content team-page">
    <div className="title-row"><div><h1>Equipe e contas</h1><p>Defina quem publica e qual perfil local do Brave cada pessoa utiliza.</p></div><div className="title-actions"><button className="secondary" onClick={()=>setModal('account')}><Laptop size={17}/>Associar perfil</button><button className="primary" onClick={()=>setModal('user')}><UserPlus size={18}/>Adicionar vendedor</button></div></div>
    <div className="security-note"><ShieldCheck/><div><strong>Sessões permanecem no computador do vendedor</strong><p>O AutoFlow armazena somente o nome do perfil do navegador. Senhas, cookies e tokens do Facebook não são enviados ao servidor.</p></div></div>
    <div className="team-grid">
      <article className="team-panel"><div className="panel-heading"><div><h2>Pessoas</h2><span>{team.length} membros</span></div></div><div className="people-list">{team.map(user=><div className="person-row" key={user.id}><span className="person-avatar">{user.name.split(' ').map(n=>n[0]).slice(0,2).join('')}</span><div><strong>{user.name}</strong><small>{user.email}</small></div><span className={`role ${user.role}`}>{user.role==='admin'?'Administrador':'Vendedor'}</span></div>)}</div></article>
      <article className="team-panel"><div className="panel-heading"><div><h2>Perfis de publicação</h2><span>{accounts.length} associados</span></div><button className="small-add" onClick={()=>setModal('account')}><Plus size={16}/></button></div>{accounts.length ? <div className="account-list">{accounts.map(account=>{const owner=team.find(u=>u.id===account.userId);return <div className="account-card" key={account.id}><span className="browser-icon"><Laptop/></span><div><strong>{account.label}</strong><small>{account.browserProfile} · {owner?.name||'Sem responsável'}</small></div><span className="connection"><i/>Aguardando extensão</span></div>})}</div>:<div className="account-empty"><Laptop/><h3>Nenhum perfil associado</h3><p>Cadastre o perfil do Brave usado por cada vendedor. A conexão será confirmada pela extensão.</p><button className="secondary" onClick={()=>setModal('account')}>Associar primeiro perfil</button></div>}</article>
    </div>
    {modal&&<div className="overlay" onMouseDown={()=>setModal(null)}><aside className="drawer" onMouseDown={e=>e.stopPropagation()}><button className="close" onClick={()=>setModal(null)}><X/></button>{modal==='user'?<><span className="eyebrow">NOVA PESSOA</span><h2>Adicionar vendedor</h2><p>Crie um acesso individual. A senha é temporária e deve ser enviada ao vendedor por um canal seguro.</p><form onSubmit={e=>{onAddUser(e);setModal(null)}}><label>Nome completo<input name="name" required/></label><label>E-mail<input name="email" type="email" required/></label><label>Senha temporária<input name="password" type="password" minLength={8} required/></label><label>Função<select name="role"><option value="seller">Vendedor</option><option value="admin">Administrador</option></select></label><button className="primary">Criar acesso</button></form></>:<><span className="eyebrow">PERFIL LOCAL</span><h2>Associar perfil do Brave</h2><p>Use um perfil separado para cada pessoa. Não informe e-mail, senha ou cookie do Facebook.</p><form onSubmit={e=>{onAddAccount(e);setModal(null)}}><label>Identificação<input name="label" placeholder="Ex.: Facebook — Marina" required/></label><label>Responsável<select name="userId" required><option value="">Selecione</option>{team.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label><label>Nome do perfil no Brave<input name="browserProfile" placeholder="Ex.: Perfil 2" required/></label><button className="primary">Associar perfil</button></form></>}</aside></div>}
  </section>
}

function Login({onSubmit,error,loading,theme}:{onSubmit:(e:React.FormEvent<HTMLFormElement>)=>void,error:string,loading:boolean,theme:'light'|'dark'}) {
  return <div className={`login-page ${theme==='dark'?'theme-dark':''}`}><section className="login-aside"><div className="brand light"><span className="brand-mark"><Car size={22}/></span><span>AutoFlow</span></div><div><span className="eyebrow light-text">OPERAÇÃO MULTICONTA</span><h1>Seu estoque pronto para vender, em um só lugar.</h1><p>Organize veículos, vendedores e filas de publicação sem compartilhar credenciais pessoais.</p></div><small>Ambiente local seguro para desenvolvimento</small></section><main className="login-main"><form className="login-card" onSubmit={onSubmit}><span className="login-logo"><Car/></span><h2>Bem-vindo</h2><p>Acesse o painel da sua empresa.</p>{error&&<div className="auth-error"><CircleAlert size={16}/>{error}</div>}<label>E-mail<input name="email" type="email" defaultValue="admin@autoflow.local" required/></label><label>Senha<input name="password" type="password" defaultValue="demo1234" required/></label><button className="primary" disabled={loading}>{loading?'Entrando...':'Entrar no painel'}</button><small>Conta de demonstração preenchida automaticamente.</small></form></main></div>
}
