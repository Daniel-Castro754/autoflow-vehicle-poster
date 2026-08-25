import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Car, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock3,
  Edit3, ImagePlus, MoreHorizontal, Plus, Search, Send, Tag, Trash2, X,
} from 'lucide-react'
import { FieldLabel, HelpTip } from './HelpTip'
import {
  BODY_TYPES, FUEL_TYPES, TRANSMISSIONS, VEHICLE_COLORS, VEHICLE_CONDITIONS, VEHICLE_MAKES,
  VEHICLE_STATUSES, VEHICLE_TYPES, VEHICLE_YEARS, withLegacyOption,
} from './vehicleOptions'

type ApiFn = <T=Record<string,unknown>>(path:string, options?:RequestInit) => Promise<T>
type AccountOption = { id:number; label:string; browserProfile?:string }
type MenuState = { vehicleId:number; top:number; left:number }

export type VehicleRecord = {
  id:number
  year:number
  make:string
  model:string
  trim:string
  price:number
  km:number
  seller:string
  initials:string
  status:'Pronto'|'Publicado'|'Rascunho'|'Atenção'|'Vendido'
  color:string
  updatedAt?:string
  vehicleType?:string
  location?:string
  transmission?:string
  fuelType?:string
  bodyType?:string
  condition?:string
  exteriorColor?:string
  interiorColor?:string
  description?:string
  imageCount?:number
  thumbnailUrl?:string
  soldAt?:string
  pendingRemovalCount?:number
}

type ImageRecord = { id:number; originalName:string; url:string; mimeType:string }
const money = new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL', maximumFractionDigits:0 })

function Badge({status}:{status:VehicleRecord['status']}) {
  const icon = status === 'Publicado' ? <Check size={13}/>
    : status === 'Atenção' ? <CircleAlert size={13}/>
      : status === 'Rascunho' ? <Clock3 size={13}/>
        : status === 'Vendido' ? <Tag size={13}/> : <span className="dot"/>
  return <span className={`badge ${status.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')}`}>{icon}{status}</span>
}

function Thumb({vehicle}:{vehicle:VehicleRecord}) {
  return <div className="car-thumb" style={{background:vehicle.color}}>
    {vehicle.thumbnailUrl ? <img src={vehicle.thumbnailUrl} alt=""/> : <Car size={30} strokeWidth={1.4}/>}
    {Boolean(vehicle.imageCount) && <span className="photo-count">{vehicle.imageCount}</span>}
  </div>
}

async function filePayload(file:File) {
  const dataBase64 = await new Promise<string>((resolve,reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  return {name:file.name, mimeType:file.type, dataBase64}
}

export default function VehiclesView({api,vehicles,accounts,reload,notify}:{api:ApiFn;vehicles:VehicleRecord[];accounts:AccountOption[];reload:()=>Promise<void>;notify:(message:string)=>void}) {
  const [query,setQuery] = useState('')
  const [status,setStatus] = useState('Todos')
  const [selected,setSelected] = useState<Set<number>>(new Set())
  const [menu,setMenu] = useState<MenuState|null>(null)
  const [editor,setEditor] = useState<VehicleRecord|null|undefined>(undefined)
  const [queueVehicle,setQueueVehicle] = useState<VehicleRecord|null>(null)

  const filtered = useMemo(() => vehicles.filter(vehicle =>
    `${vehicle.make} ${vehicle.model} ${vehicle.year} ${vehicle.seller}`.toLowerCase().includes(query.toLowerCase())
    && (status === 'Todos' || vehicle.status === status)
  ), [vehicles,query,status])
  const allSelected = filtered.length > 0 && filtered.every(vehicle => selected.has(vehicle.id))
  const menuVehicle = menu ? vehicles.find(vehicle => vehicle.id === menu.vehicleId) : undefined

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('resize',close)
    window.addEventListener('scroll',close,true)
    return () => { window.removeEventListener('resize',close); window.removeEventListener('scroll',close,true) }
  }, [menu])

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(filtered.map(vehicle => vehicle.id)))
  }

  function toggleOne(id:number) {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleMenu(event:React.MouseEvent<HTMLButtonElement>, vehicleId:number) {
    event.stopPropagation()
    if (menu?.vehicleId === vehicleId) return setMenu(null)
    const rect = event.currentTarget.getBoundingClientRect()
    const width = 238
    const estimatedHeight = 174
    const left = Math.max(10, Math.min(window.innerWidth - width - 10, rect.right - width))
    const top = rect.bottom + estimatedHeight + 8 > window.innerHeight
      ? Math.max(10, rect.top - estimatedHeight - 8)
      : rect.bottom + 8
    setMenu({vehicleId,top,left})
  }

  async function remove(ids:number[]) {
    if (!ids.length || !window.confirm(`Excluir ${ids.length} veículo${ids.length>1?'s':''}? Fotos e publicações relacionadas também serão removidas.`)) return
    try {
      const result = await api<{deleted:number}>('/vehicles',{method:'DELETE',body:JSON.stringify({ids})})
      setSelected(new Set()); setMenu(null)
      notify(`${result.deleted} veículo${result.deleted===1?'':'s'} excluído${result.deleted===1?'':'s'}.`)
      await reload()
    } catch (error) { notify(error instanceof Error ? error.message : 'Erro ao excluir veículos') }
  }

  async function markSold(vehicleId:number) {
    setMenu(null)
    try {
      await api(`/vehicles/${vehicleId}/mark-sold`,{method:'POST'})
      notify('Veículo marcado como vendido. Lembre-se de remover o anúncio do Facebook em até 24h.')
      await reload()
    } catch (error) { notify(error instanceof Error ? error.message : 'Erro ao marcar veículo como vendido') }
  }

  return <section className="content vehicles-page">
    <div className="title-row">
      <div><h1>Veículos</h1><p>Gerencie dados, fotos e publicações do estoque.</p></div>
      <div className="action-with-help"><button className="primary" onClick={()=>setEditor(null)}><Plus size={18}/>Adicionar veículo</button><HelpTip text="Cadastre todos os dados e as fotos antes de colocar o veículo na fila de publicação." placement="bottom"/></div>
    </div>
    <div className="stats">
      <article><span className="stat-icon blue"><Car/></span><div><small>Total no estoque</small><strong>{vehicles.length}</strong><em>veículos ativos</em></div></article>
      <article><span className="stat-icon green"><Check/></span><div><small>Publicados</small><strong>{vehicles.filter(v=>v.status==='Publicado').length}</strong><em>anúncios ativos</em></div></article>
      <article><span className="stat-icon amber"><Clock3/></span><div><small>Na fila</small><strong>{vehicles.filter(v=>v.status==='Pronto').length}</strong><em>aguardando vendedor</em></div></article>
      <article><span className="stat-icon red"><CircleAlert/></span><div><small>Precisam de atenção</small><strong>{vehicles.filter(v=>v.status==='Atenção').length}</strong><em>revisar dados</em></div></article>
    </div>
    <div className="panel">
      <div className="toolbar"><div className="search"><Search size={18}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Buscar veículo ou vendedor..."/></div><select value={status} onChange={event=>setStatus(event.target.value)}><option>Todos</option>{VEHICLE_STATUSES.map(item=><option key={item}>{item}</option>)}</select><button className="secondary">Todas as lojas<ChevronDown size={15}/></button></div>
      {selected.size>0 && <div className="bulk-bar"><div><Check/><strong>{selected.size}</strong><span>selecionado{selected.size>1?'s':''}</span></div><HelpTip tone="warning" text="A exclusão remove os veículos, suas fotos e os registros de publicação relacionados. Uma confirmação será solicitada." placement="bottom"/><button onClick={()=>remove([...selected])}><Trash2/>Excluir selecionados</button><button className="bulk-clear" onClick={()=>setSelected(new Set())}><X/>Limpar</button></div>}
      <div className="table-wrap"><table><thead><tr><th className="check-cell"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Selecionar todos os veículos"/></th><th>VEÍCULO</th><th>PREÇO</th><th>QUILOMETRAGEM</th><th>RESPONSÁVEL</th><th>STATUS</th><th>FOTOS</th><th>ATUALIZADO</th><th/></tr></thead><tbody>{filtered.map(vehicle=><tr key={vehicle.id} className={selected.has(vehicle.id)?'selected-row':''}>
        <td className="check-cell"><input type="checkbox" checked={selected.has(vehicle.id)} onChange={()=>toggleOne(vehicle.id)} aria-label={`Selecionar ${vehicle.year} ${vehicle.make} ${vehicle.model}`}/></td>
        <td><div className="vehicle"><Thumb vehicle={vehicle}/><div><strong>{vehicle.year} {vehicle.make} {vehicle.model}</strong><small>{vehicle.trim}</small></div></div></td>
        <td><strong>{money.format(vehicle.price)}</strong></td><td>{vehicle.km.toLocaleString('pt-BR')} km</td>
        <td><div className="seller"><span>{vehicle.initials}</span>{vehicle.seller}</div></td><td><Badge status={vehicle.status}/></td>
        <td><span className={`image-status ${vehicle.imageCount?'has-images':''}`}>{vehicle.imageCount||0}/20</span></td>
        <td className="muted">{vehicle.updatedAt?new Date(vehicle.updatedAt+'Z').toLocaleDateString('pt-BR'):'agora'}</td>
        <td className="actions-cell"><button className="row-more" onClick={event=>toggleMenu(event,vehicle.id)} aria-label={`Ações de ${vehicle.year} ${vehicle.make} ${vehicle.model}`} aria-expanded={menu?.vehicleId===vehicle.id}><MoreHorizontal/></button></td>
      </tr>)}</tbody></table>{!filtered.length&&<div className="empty">Nenhum veículo encontrado.</div>}</div>
      <footer className="panel-foot"><span>Mostrando {filtered.length} de {vehicles.length} veículos</span><div><button disabled>Anterior</button><button className="page">1</button><button>Próximo</button></div></footer>
    </div>

    {menu && menuVehicle && createPortal(<><button className="row-menu-backdrop" onClick={()=>setMenu(null)} aria-label="Fechar ações"/><div className="row-menu floating-row-menu" style={{top:menu.top,left:menu.left}} role="menu">
      <div className="row-menu-action"><button onClick={()=>{setEditor(menuVehicle);setMenu(null)}}><Edit3/>Editar e gerenciar fotos</button></div>
      <div className="row-menu-action"><button onClick={()=>{setQueueVehicle(menuVehicle);setMenu(null)}}><Send/>Adicionar à fila</button><HelpTip text="Escolha o perfil do Brave. A extensão seguirá as etapas de avanço, grupos e publicação definidas em Configurações." placement="bottom"/></div>
      {menuVehicle.status!=='Vendido'&&<div className="row-menu-action"><button onClick={()=>markSold(menuVehicle.id)}><Tag/>Marcar como vendido</button><HelpTip tone="warning" text="Remova o anúncio do Facebook em até 24h após a venda. O AutoFlow vai lembrar você." placement="bottom"/></div>}
      <div className="row-menu-action danger"><button onClick={()=>remove([menuVehicle.id])}><Trash2/>Excluir veículo</button><HelpTip tone="warning" text="Também remove fotos e históricos de publicação deste veículo." placement="bottom"/></div>
    </div></>,document.body)}
    {editor!==undefined && <VehicleDrawer api={api} vehicle={editor} onClose={()=>setEditor(undefined)} onSaved={async message=>{setEditor(undefined);notify(message);await reload()}}/>}
    {queueVehicle && <QueueDrawer api={api} vehicle={queueVehicle} accounts={accounts} onClose={()=>setQueueVehicle(null)} onQueued={async()=>{setQueueVehicle(null);notify('Veículo adicionado à fila do perfil selecionado. Abra ou atualize a extensão.');await reload()}}/>}
  </section>
}

function QueueDrawer({api,vehicle,accounts,onClose,onQueued}:{api:ApiFn;vehicle:VehicleRecord;accounts:AccountOption[];onClose:()=>void;onQueued:()=>Promise<void>}) {
  const [accountId,setAccountId] = useState(accounts[0]?.id || 0)
  const [saving,setSaving] = useState(false)
  const [error,setError] = useState('')

  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError('')
    try {
      await api('/publications',{method:'POST',body:JSON.stringify({vehicleId:vehicle.id,accountId})})
      await onQueued()
    } catch (caught) {
      const missing = (caught as {missing?:string[]})?.missing
      setError(missing?.length ? `Complete antes de publicar: ${missing.join(', ')}.` : caught instanceof Error ? caught.message : 'Erro ao adicionar à fila')
      setSaving(false)
    }
  }

  return <div className="overlay" onMouseDown={onClose}><aside className="drawer queue-drawer" onMouseDown={event=>event.stopPropagation()}>
    <button className="close" onClick={onClose} aria-label="Fechar fila"><X/></button><span className="eyebrow">FILA DA EXTENSÃO</span><h2>Escolher perfil do Brave</h2>
    <p>{vehicle.year} {vehicle.make} {vehicle.model} será exibido somente na fila do perfil selecionado.</p>
    {error&&<div className="auth-error"><CircleAlert/>{error}</div>}
    {accounts.length ? <form onSubmit={submit}><label>Perfil que fará o preenchimento<select value={accountId} onChange={event=>setAccountId(Number(event.target.value))} required>{accounts.map(account=><option key={account.id} value={account.id}>{account.label}{account.browserProfile?` · ${account.browserProfile}`:''}</option>)}</select></label><div className="queue-explanation"><Send/><div><strong>Depois de adicionar</strong><span>Abra a extensão nesse perfil do Brave e clique em “Abrir e preencher”.</span></div></div><button className="primary" disabled={saving||!accountId}>{saving?'Adicionando...':'Adicionar à fila deste perfil'}</button></form> : <div className="account-empty"><Send/><h3>Nenhum perfil associado</h3><p>Cadastre um perfil em Equipe e contas antes de criar a tarefa da extensão.</p></div>}
  </aside></div>
}

function VehicleDrawer({api,vehicle,onClose,onSaved}:{api:ApiFn;vehicle:VehicleRecord|null;onClose:()=>void;onSaved:(message:string)=>Promise<void>}) {
  const [images,setImages] = useState<ImageRecord[]>([])
  const [files,setFiles] = useState<File[]>([])
  const [saving,setSaving] = useState(false)
  const [error,setError] = useState('')

  useEffect(() => { if(vehicle) api<{images:ImageRecord[]}>(`/vehicles/${vehicle.id}/images`).then(data=>setImages(data.images)).catch(()=>setImages([])) }, [api,vehicle])

  async function upload(vehicleId:number) {
    for (const file of files.slice(0,20-images.length)) await api(`/vehicles/${vehicleId}/images`,{method:'POST',body:JSON.stringify(await filePayload(file))})
  }

  async function submit(event:React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError('')
    const form = new FormData(event.currentTarget)
    const payload = {
      year:Number(form.get('year')), make:form.get('make'), model:form.get('model'), trim:form.get('trim'),
      price:Number(form.get('price')), km:Number(form.get('km')), vehicleType:form.get('vehicleType'),
      location:form.get('location'), transmission:form.get('transmission'), fuelType:form.get('fuelType'),
      bodyType:form.get('bodyType'), exteriorColor:form.get('exteriorColor'), interiorColor:form.get('interiorColor'),
      condition:form.get('condition'),
      description:form.get('description'), status:form.get('status'),
    }
    try {
      let id=vehicle?.id
      if (id) await api(`/vehicles/${id}`,{method:'PATCH',body:JSON.stringify(payload)})
      else id=(await api<{id:number}>('/vehicles',{method:'POST',body:JSON.stringify(payload)})).id
      await upload(id!)
      await onSaved(vehicle?'Veículo atualizado com sucesso.':'Veículo adicionado ao estoque.')
    } catch (caught) { setError(caught instanceof Error?caught.message:'Erro ao salvar veículo'); setSaving(false) }
  }

  async function removeImage(image:ImageRecord) {
    await api(`/vehicle-images/${image.id}`,{method:'DELETE'})
    setImages(current=>current.filter(item=>item.id!==image.id))
  }

  async function moveImage(index:number,direction:-1|1) {
    const target=index+direction
    if(target<0||target>=images.length||!vehicle)return
    const next=[...images]; [next[index],next[target]]=[next[target],next[index]]
    const previous=images; setImages(next)
    try { await api(`/vehicles/${vehicle.id}/images/reorder`,{method:'PATCH',body:JSON.stringify({order:next.map(item=>item.id)})}) }
    catch(caught) { setImages(previous); setError(caught instanceof Error?caught.message:'Erro ao reordenar fotos') }
  }

  return <div className="overlay" onMouseDown={onClose}><aside className="drawer vehicle-drawer" onMouseDown={event=>event.stopPropagation()}>
    <button className="close" onClick={onClose} aria-label="Fechar veículo"><X/></button><span className="eyebrow">{vehicle?'EDITAR ESTOQUE':'NOVO REGISTRO'}</span><h2>{vehicle?'Editar veículo':'Adicionar veículo'}</h2><p>Escolha os mesmos valores usados pelo Marketplace e adicione até 20 fotos.</p>{error&&<div className="auth-error"><CircleAlert/>{error}</div>}
    <form onSubmit={submit}>
      <div className="drawer-section"><h3>Identificação</h3><div className="vehicle-form-grid">
        <label><FieldLabel help="Define a categoria inicial do formulário do Marketplace.">Tipo de veículo</FieldLabel><select name="vehicleType" defaultValue={vehicle?.vehicleType||'Carro/picape'} required>{withLegacyOption(VEHICLE_TYPES,vehicle?.vehicleType).map(item=><option key={item}>{item}</option>)}</select></label>
        <label><FieldLabel help="Ano/modelo anunciado. A lista acompanha os anos aceitos pelo Marketplace.">Ano</FieldLabel><select name="year" defaultValue={vehicle?.year||new Date().getFullYear()} required>{VEHICLE_YEARS.map(year=><option key={year} value={year}>{year}</option>)}</select></label>
        <label><FieldLabel help="Selecione a montadora exatamente como aparece no Marketplace.">Fabricante</FieldLabel><select name="make" defaultValue={vehicle?.make||''} required><option value="" disabled>Selecione a fabricante</option>{withLegacyOption(VEHICLE_MAKES,vehicle?.make).map(item=><option key={item}>{item}</option>)}</select></label>
        <label><FieldLabel help="Informe o modelo sem repetir fabricante ou ano. A extensão tentará escolher a sugestão correspondente.">Modelo</FieldLabel><input name="model" defaultValue={vehicle?.model||''} placeholder="Corolla" required/></label>
        <label><FieldLabel help="Versão ou acabamento, por exemplo XEi 2.0.">Versão</FieldLabel><input name="trim" defaultValue={vehicle?.trim||''} placeholder="XEi 2.0"/></label>
        <label><FieldLabel help="Cidade usada no anúncio. O Facebook pode pedir a confirmação de uma sugestão.">Localização</FieldLabel><input name="location" defaultValue={vehicle?.location||''} placeholder="Criciúma, SC" required/></label>
      </div></div>
      <div className="drawer-section"><h3>Detalhes</h3><div className="vehicle-form-grid">
        <label><FieldLabel help="Valor total anunciado, sem pontos ou símbolo de moeda.">Preço</FieldLabel><input name="price" type="number" min="1" defaultValue={vehicle?.price||0} required/></label>
        <label><FieldLabel help="Quilometragem atual em números inteiros. Veículo zero km pode usar 0.">Quilometragem</FieldLabel><input name="km" type="number" min="0" defaultValue={vehicle?.km||0} required/></label>
        <label><FieldLabel help="Opções limitadas aos valores aceitos pelo Marketplace.">Câmbio</FieldLabel><select name="transmission" defaultValue={vehicle?.transmission||'Automático'} required>{withLegacyOption(TRANSMISSIONS,vehicle?.transmission).map(item=><option key={item}>{item}</option>)}</select></label>
        <label><FieldLabel help="Informe o combustível principal aceito pelo veículo.">Combustível</FieldLabel><select name="fuelType" defaultValue={vehicle?.fuelType||'Flex'} required>{withLegacyOption(FUEL_TYPES,vehicle?.fuelType).map(item=><option key={item}>{item}</option>)}</select></label>
        <label><FieldLabel help="Formato da carroceria conforme a lista do Facebook.">Carroceria</FieldLabel><select name="bodyType" defaultValue={vehicle?.bodyType||'Sedã'} required>{withLegacyOption(BODY_TYPES,vehicle?.bodyType).map(item=><option key={item}>{item}</option>)}</select></label>
        <label><FieldLabel help="Estado geral do veículo conforme as opções fixas exibidas pelo Marketplace.">Condição do veículo</FieldLabel><select name="condition" defaultValue={vehicle?.condition||''} required><option value="" disabled>Selecione a condição</option>{withLegacyOption(VEHICLE_CONDITIONS,vehicle?.condition).map(item=><option key={item}>{item}</option>)}</select></label>
        <label><FieldLabel help="Selecione a cor externa exatamente como aparece no Marketplace.">Cor externa</FieldLabel><select name="exteriorColor" defaultValue={vehicle?.exteriorColor||''} required><option value="" disabled>Selecione a cor externa</option>{withLegacyOption(VEHICLE_COLORS,vehicle?.exteriorColor).map(item=><option key={item}>{item}</option>)}</select></label>
        <label><FieldLabel help="Selecione a cor predominante do interior. Este campo também é uma lista fixa no Marketplace.">Cor interna</FieldLabel><select name="interiorColor" defaultValue={vehicle?.interiorColor||''} required><option value="" disabled>Selecione a cor interna</option>{withLegacyOption(VEHICLE_COLORS,vehicle?.interiorColor).map(item=><option key={item}>{item}</option>)}</select></label>
        <label><FieldLabel help="O status muda automaticamente ao entrar na fila e ao confirmar a publicação.">Status</FieldLabel><select name="status" defaultValue={vehicle?.status||'Rascunho'}>{VEHICLE_STATUSES.map(item=><option key={item}>{item}</option>)}</select></label>
      </div><label><FieldLabel help="Inclua conservação, opcionais e condições reais. Evite promessas não verificáveis.">Descrição</FieldLabel><textarea name="description" rows={5} defaultValue={vehicle?.description||''} placeholder="Descreva conservação, opcionais e condições..." required/></label></div>
      <div className="drawer-section"><h3 className="section-title-help">Fotos <span>{images.length+files.length}/20</span><HelpTip text="A primeira foto vira a capa. Use as setas para reordenar; a extensão envia no máximo 20 na ordem cadastrada."/></h3>
        {images.length>0&&<div className="image-grid">{images.map((image,index)=><div key={image.id}>{index===0&&<span className="cover-badge">Capa</span>}<img src={image.url} alt={image.originalName}/><button type="button" onClick={()=>removeImage(image)} aria-label={`Excluir ${image.originalName}`}><X/></button><div className="move-controls"><button type="button" disabled={index===0} onClick={()=>moveImage(index,-1)} aria-label={`Mover ${image.originalName} para a esquerda`}><ChevronLeft/></button><button type="button" disabled={index===images.length-1} onClick={()=>moveImage(index,1)} aria-label={`Mover ${image.originalName} para a direita`}><ChevronRight/></button></div></div>)}</div>}
        <label className="image-upload"><ImagePlus/><strong>Adicionar fotos</strong><span>JPG, PNG ou WebP · até 12 MB cada</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event=>setFiles([...event.target.files||[]].slice(0,20-images.length))}/></label>
        {files.length>0&&<div className="pending-files">{files.map(file=><span key={file.name}>{file.name}</span>)}</div>}
      </div>
      <button className="primary save-vehicle" disabled={saving}>{saving?'Salvando...':vehicle?'Salvar alterações':'Adicionar ao estoque'}</button>
    </form>
  </aside></div>
}
