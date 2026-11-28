import type { DatabaseSync } from 'node:sqlite'
import { normalizeInventoryIdentifier, validateInventoryIdentifiers } from './vehicle-import.ts'
import { vehicleOptions, validateVehicleBody } from './vehicle-input.ts'

export class StockSyncInputError extends Error {}
const detailFields=['vehicleType','location','transmission','fuelType','bodyType','exteriorColor','interiorColor','condition','description'] as const
type DetailField=typeof detailFields[number]
type CommercialState='available'|'sold'
type SourceRow = { commercialState?:CommercialState; stockCode:string; vin?:string; year:number; make:string; model:string; trim?:string; price:number; km:number } & Partial<Record<DetailField,string>>
type LocalRow = SourceRow & { id:number; status:string; soldAt:string|null; protectedWork:number; photoCount:number }
type Category = 'new'|'changed'|'unchanged'|'conflict'
type Entry = {stockCode:string; category:Category; vehicleId?:number; changedFields?:string[]; reason?:string}
const fields=['year','make','model','trim','price','km',...detailFields] as const
type PhotoRow={stockCode:string;sha256:string}
function parsePhoto(value:unknown):PhotoRow {
  const v=object(value)
  if(Object.keys(v).some(k=>!['stockCode','sha256'].includes(k)))return fail('Campo de foto não permitido.')
  const stockCode=identifier(v.stockCode)
  if(validateInventoryIdentifiers(stockCode,'')||typeof v.sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(v.sha256))return fail('Identificador ou hash de foto inválido.')
  return {stockCode,sha256:v.sha256.toLowerCase()}
}
const maxRows=500
const maxLocalRows=10000
const fail=(message:string):never=>{throw new StockSyncInputError(message)}
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail('Objeto de sincronização inválido.')
  return value as Record<string,unknown>
}
function text(value:unknown,max:number,required=true):string{
  if(typeof value!=='string'||value.length>max||(required&&!value.trim()))return fail('Campo textual inválido.')
  return value.trim()
}
function identifier(value:unknown,required=true){
  const raw=text(value,128,required)
  if(raw.toUpperCase().replace(/\s+/g,'').length>64)return fail('Identificador de estoque/chassi excede o limite.')
  return normalizeInventoryIdentifier(raw)
}
function numeric(value:unknown,min:number,max:number,integer=false):number{
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))return fail('Campo numérico inválido.')
  return value
}
function parseRow(value:unknown):SourceRow{
  const v=object(value)
  if(Object.keys(v).some(k=>!['stockCode','vin','commercialState',...fields].includes(k)))return fail('Campo de veículo não permitido nesta prévia.')
  const stockCode=identifier(v.stockCode)
  const vin=v.vin===undefined?undefined:identifier(v.vin,false)
  if(validateInventoryIdentifiers(stockCode,vin||''))return fail('Identificador de estoque/chassi inválido.')
  const make=text(v.make,100)
  if(!vehicleOptions.make.has(make))return fail('Fabricante fora do catálogo.')
  const commercialState=v.commercialState
  if(commercialState!==undefined&&commercialState!=='available'&&commercialState!=='sold')return fail('Situação comercial inválida.')
  const details:Partial<Record<DetailField,string>>={}
  for(const field of detailFields){
    if(v[field]!==undefined)details[field]=text(v[field],field==='description'?4000:200,false)
  }
  return {...details,commercialState,stockCode,vin,year:numeric(v.year,1900,new Date().getFullYear()+1,true),make,model:text(v.model,150),
    trim:v.trim===undefined?undefined:text(v.trim,150,false),
    price:numeric(v.price,0.01,1000000000),km:numeric(v.km,0,10000000)}
}
function index<T>(rows:T[],key:(row:T)=>string){
  const result=new Map<string,T[]>()
  for(const row of rows){
    const k=key(row)
    if(k){const values=result.get(k)||[];values.push(row);result.set(k,values)}
  }
  return result
}

// This is a submitted snapshot, not proof of Google access or completeness.
// Read-only, no status transitions, downloads, inserts, updates or scheduling.
export function previewStockSync(db:DatabaseSync,org:number,input:unknown){
  const v=object(input)
  if(Object.keys(v).some(k=>!['version','source','sourceState','rows','photos'].includes(k))||v.version!==1||
    typeof v.source!=='string'||!['sheets','activepieces','manual'].includes(v.source)||
    typeof v.sourceState!=='string'||!['complete','partial','failed'].includes(v.sourceState)||
    !Array.isArray(v.rows)||v.rows.length>maxRows||(v.sourceState==='failed'&&v.rows.length))return fail('Envelope de sincronização inválido.')
  const rows=v.rows.map(parseRow)
  if(v.photos!==undefined&&(!Array.isArray(v.photos)||v.photos.length>2000||(v.sourceState==='failed'&&v.photos.length)))return fail('Manifesto de fotos inválido.')
  const photos=Array.isArray(v.photos)?v.photos.map(parsePhoto):undefined
  const local=db.prepare(`SELECT v.id,v.stock_code stockCode,v.vin,v.year,v.make,v.model,v.trim,v.price,v.km,v.status,v.sold_at soldAt,
    v.vehicle_type vehicleType,v.location,v.transmission,v.fuel_type fuelType,v.body_type bodyType,
    v.exterior_color exteriorColor,v.interior_color interiorColor,v.vehicle_condition condition,v.description,
    (SELECT COUNT(*) FROM vehicle_images i WHERE i.organization_id=v.organization_id AND i.vehicle_id=v.id) photoCount,
    EXISTS(SELECT 1 FROM publication_jobs j WHERE j.organization_id=v.organization_id AND j.vehicle_id=v.id
      AND j.status IN ('pending','filling','error','awaiting_confirmation','completed')) protectedWork
    FROM vehicles v WHERE v.organization_id=? ORDER BY v.id LIMIT ?`).all(org,maxLocalRows+1) as LocalRow[]
  if(local.length>maxLocalRows)return fail('Estoque local excede o limite seguro desta prévia.')
  const localStock=index(local,r=>normalizeInventoryIdentifier(r.stockCode))
  const localVin=index(local,r=>normalizeInventoryIdentifier(r.vin))
  const sourceStock=index(rows,r=>r.stockCode)
  const sourceVin=index(rows,r=>r.vin||'')
  const entries:Entry[]=rows.map(row=>{
    const base={stockCode:row.stockCode}
    const matches=localStock.get(row.stockCode)||[]
    const vinMatches=row.vin?localVin.get(row.vin)||[]:[]
    if((sourceStock.get(row.stockCode)?.length||0)>1||(row.vin&&(sourceVin.get(row.vin)?.length||0)>1))return {...base,category:'conflict',reason:'duplicate_source_identifier'}
    if(matches.length>1||vinMatches.length>1||vinMatches.some(match=>match.id!==matches[0]?.id))return {...base,category:'conflict',reason:'local_identity_conflict'}
    const current=matches[0]
    if(!current)return row.commercialState==='sold'?{...base,category:'conflict',reason:'source_sale_unknown_vehicle'}:{...base,category:'new'}
    if(row.vin&&current.vin&&row.vin!==normalizeInventoryIdentifier(current.vin))return {...base,vehicleId:current.id,category:'conflict',reason:'vin_mismatch'}
    const localSold=Boolean(current.soldAt||current.status==='Vendido')
    if(row.commercialState==='sold'){
      // A recycled stock code must not be mistaken for proof of a sale.
      const detailsMatch=row.year===current.year&&row.make===current.make&&row.model===current.model
      const vinVerified=!current.vin||row.vin===normalizeInventoryIdentifier(current.vin)
      if(!detailsMatch||!vinVerified)return {...base,vehicleId:current.id,category:'conflict',reason:'source_sale_identity_unverified'}
      return localSold?{...base,vehicleId:current.id,category:'unchanged',reason:'source_sale_already_recorded'}:
        {...base,vehicleId:current.id,category:'conflict',reason:'source_sale_requires_review'}
    }
    if(row.commercialState==='available'&&localSold)return {...base,vehicleId:current.id,category:'conflict',reason:'source_available_local_sold'}
    const changedFields:string[]=fields.filter(field=>row[field]!==undefined&&row[field]!==current[field])
    if(row.vin&&!current.vin)changedFields.push('vin')
    if(!changedFields.length)return {...base,vehicleId:current.id,category:'unchanged'}
    if(current.soldAt||['Vendido','Publicado'].includes(current.status)||current.protectedWork)return {...base,vehicleId:current.id,category:'conflict',changedFields,reason:'protected_local_vehicle'}
    return {...base,vehicleId:current.id,category:'changed',changedFields}
  })
  const counts={new:0,changed:0,unchanged:0,conflict:0}
  for(const entry of entries)counts[entry.category]++
  const absenceComparable=v.sourceState==='complete'&&rows.length>0&&counts.conflict===0
  const notSeen=absenceComparable?local.filter(row=>!row.soldAt&&row.status!=='Vendido'&&row.stockCode&&!sourceStock.has(normalizeInventoryIdentifier(row.stockCode))):[]
  const photoPreview=photos===undefined?undefined:planPhotos(db,org,photos,entries,local)
  const validation=validateSourceDetails(rows,entries,local,photoPreview)
  const commercialReview=reviewCommercialState(rows,entries,local)
  return {version:1,source:v.source,sourceState:v.sourceState,readOnly:true,sourceRows:rows.length,counts,entries,photoPreview,validation,commercialReview,
    absence:{comparable:absenceComparable,count:absenceComparable?notSeen.length:null,exampleVehicleIds:notSeen.slice(0,30).map(row=>row.id)},
    note:'Prévia dos campos fornecidos; não comprova a origem ou completude declarada. Ausência não significa venda, exclusão ou autorização para alterar o estoque. Nenhuma alteração foi executada.'}
}

function planPhotos(db:DatabaseSync,org:number,photos:PhotoRow[],entries:Entry[],local:LocalRow[]){
  type PhotoCategory='new'|'already_present'|'conflict'
  type PhotoEntry={row:number;stockCode:string;category:PhotoCategory;reason?:string}
  const byStock=index(entries,e=>e.stockCode)
  const byHash=index(photos,p=>p.sha256)
  const localById=new Map(local.map(v=>[v.id,v]))
  const gallery=db.prepare('SELECT vehicle_id vehicleId,content_hash hash FROM vehicle_images WHERE organization_id=? ORDER BY id LIMIT 200001').all(org) as {vehicleId:number;hash:string|null}[]
  if(gallery.length>200000)return fail('Galerias locais excedem o limite seguro da prévia.')
  const galleryByVehicle=index(gallery,p=>String(p.vehicleId))
  const galleryByHash=index(gallery,p=>String(p.hash||'').toLowerCase())
  const used=new Set<string>()
  const reserved=new Map<string,number>()
  const result:PhotoEntry[]=photos.map((photo,i)=>{
    const base={row:i+1,stockCode:photo.stockCode}
    const conflict=(reason:string):PhotoEntry=>({...base,category:'conflict',reason})
    const targets=byStock.get(photo.stockCode)||[]
    const target=targets[0]
    if(targets.length!==1||target.category==='conflict')return conflict('vehicle_identity_unresolved')
    if(target.reason==='source_sale_already_recorded')return conflict('protected_local_vehicle')
    if(new Set((byHash.get(photo.sha256)||[]).map(p=>p.stockCode)).size>1)return conflict('shared_source_photo')
    const current=target.vehicleId?localById.get(target.vehicleId):undefined
    const existing=galleryByHash.get(photo.sha256)||[]
    if(existing.some(p=>p.vehicleId!==current?.id))return conflict('shared_local_photo')
    if(existing.length)return {...base,category:'already_present'}
    if(current&&(current.status!=='Rascunho'||current.soldAt||current.protectedWork))return conflict('protected_local_vehicle')
    const key=photo.stockCode+':'+photo.sha256
    if(used.has(key))return conflict('duplicate_manifest_photo')
    used.add(key)
    const currentGallery=current?galleryByVehicle.get(String(current.id))||[]:[]
    if(currentGallery.some(p=>!p.hash))return conflict('unverified_local_photo')
    const n=reserved.get(photo.stockCode)||0
    if(currentGallery.length+n>=20)return conflict('photo_limit')
    reserved.set(photo.stockCode,n+1)
    return {...base,category:'new'}
  })
  const counts={new:0,already_present:0,conflict:0}
  for(const item of result)counts[item.category]++
  return {counts,entries:result,note:'Hashes declarados pelo remetente; conteúdo e origem ainda não verificados. Não autoriza download, upload, exclusão ou troca de galeria.'}
}

const catalogs:Partial<Record<DetailField,Set<string>>>={
  vehicleType:vehicleOptions.vehicleType,transmission:vehicleOptions.transmission,
  fuelType:vehicleOptions.fuelType,bodyType:vehicleOptions.bodyType,
  exteriorColor:vehicleOptions.color,interiorColor:vehicleOptions.color,condition:vehicleOptions.condition,
}

// Assess the submitted source, not a synthesized vehicle. Existing details
// and organization defaults must not silently hide missing source data.
function validateSourceDetails(rows:SourceRow[],entries:Entry[],local:LocalRow[],photoPreview:ReturnType<typeof planPhotos>|undefined){
  const localById=new Map(local.map(v=>[v.id,v]))
  const byStock=index(photoPreview?.entries||[],p=>p.stockCode)
  const items=rows.map((row,i)=>{
    const entry=entries[i]
    const missingFields=detailFields.filter(field=>!row[field]?.trim())
    const invalidFields=detailFields.filter(field=>!!row[field]?.trim()&&!!catalogs[field]&&!catalogs[field]?.has(row[field]!))
    const current=entry.vehicleId?localById.get(entry.vehicleId):undefined
    const photos=byStock.get(row.stockCode)||[]
    const localPhotoCount=entry.category==='conflict'?null:current?.photoCount??0
    const declaredNewPhotos=photos.filter(p=>p.category==='new').length
    const photoConflicts=photos.filter(p=>p.category==='conflict').length
    const sourceFieldsComplete=missingFields.length===0&&invalidFields.length===0
    const identityConflict=entry.category==='conflict'
    return {row:i+1,stockCode:row.stockCode,sourceFieldsComplete,missingFields,invalidFields,
      identityConflict,localPhotoCount,declaredNewPhotos,photoConflicts,
      requiresPhotoVerification:declaredNewPhotos>0,
      needsPhotos:!identityConflict&&localPhotoCount===0&&declaredNewPhotos===0}
  })
  return {total:items.length,completeSourceFields:items.filter(i=>i.sourceFieldsComplete).length,
    incompleteSourceFields:items.filter(i=>!i.sourceFieldsComplete).length,items,
    note:'Validação dos dados declarados, sem completar campos por inferência. Fotos locais são contagens de registros e fotos novas são apenas declarações. Não confirma conteúdo, autorização, status Pronto nem elegibilidade de publicação.'}
}

function reviewCommercialState(rows:SourceRow[],entries:Entry[],local:LocalRow[]){
  const byId=new Map(local.map(v=>[v.id,v]))
  const items=rows.flatMap((row,i)=>{
    if(row.commercialState===undefined)return []
    const entry=entries[i]
    const current=entry.vehicleId?byId.get(entry.vehicleId):undefined
    const disposition=row.commercialState==='sold'?
      entry.reason==='source_sale_already_recorded'?'already_recorded':
      entry.reason==='source_sale_requires_review'?'review_sale':'review_identity':
      entry.reason==='source_available_local_sold'?'review_availability':entry.category==='conflict'?'review_conflict':'no_sale_signal'
    return [{row:i+1,stockCode:row.stockCode,declaredState:row.commercialState,
      vehicleId:entry.vehicleId??null,disposition,reason:entry.reason??null,
      localSold:current?Boolean(current.soldAt||current.status==='Vendido'):null,
      protectedWork:current?Boolean(current.protectedWork):null,
      requiresHumanReview:disposition.startsWith('review_'),executed:false}]
  })
  return {explicitSaleSignals:items.filter(i=>i.declaredState==='sold').length,
    alreadyRecorded:items.filter(i=>i.disposition==='already_recorded').length,
    requiresReview:items.filter(i=>i.requiresHumanReview).length,items,
    note:'Situação comercial declarada pelo remetente, não comprovada. Venda explícita exige revisão da identidade, fonte e trabalhos existentes pelo operador. Ausência nunca é venda. Não reabre veículos vendidos, não altera status, fila ou anúncio externo.'}
}

// Caller holds BEGIN IMMEDIATE and has revalidated the explicit write grant.
// Only previously unknown, explicitly available vehicles may be inserted.
// Existing vehicles, photos, sales and publication jobs are never mutated.
export function applyStockDrafts(db:DatabaseSync,org:number,actor:number|null,input:unknown){
  const request=object(input)
  if(Object.keys(request).some(k=>!['confirm','snapshot'].includes(k))||request.confirm!=='create_drafts')
    return fail('Confirmação explícita create_drafts obrigatória.')
  const preview=previewStockSync(db,org,request.snapshot)
  const source=object(request.snapshot)
  const rows=(source.rows as unknown[]).map(parseRow)
  if(preview.sourceState!=='complete'||!rows.length||preview.counts.conflict||preview.photoPreview?.counts.conflict)
    return {applied:false,reason:'snapshot_requires_review',created:[],counts:preview.counts}
  const created:{stockCode:string;vehicleId:number}[]=[]
  const skipped:{stockCode:string;reason:string}[]=[]
  const insert=db.prepare(`INSERT INTO vehicles
    (organization_id,year,make,model,trim,price,km,stock_code,vin,status,assigned_user_id,
     vehicle_type,location,transmission,fuel_type,body_type,exterior_color,interior_color,vehicle_condition,description)
    VALUES (?,?,?,?,?,?,?,?,?,'Rascunho',?,?,?,?,?,?,?,?,?,?)`)
  for(const [i,row] of rows.entries()){
    const entry=preview.entries[i]
    if(entry.category!=='new'){
      skipped.push({stockCode:row.stockCode,reason:entry.category==='changed'?'existing_change_requires_review':'already_exists'})
      continue
    }
    if(row.commercialState!=='available'||!preview.validation.items[i].sourceFieldsComplete||
      validateVehicleBody({...row,status:'Rascunho'})){
      skipped.push({stockCode:row.stockCode,reason:'explicit_availability_and_complete_fields_required'})
      continue
    }
    const result=insert.run(org,row.year,row.make,row.model,row.trim??'',row.price,row.km,row.stockCode,row.vin??'',actor,
      row.vehicleType!,row.location!,row.transmission!,row.fuelType!,row.bodyType!,row.exteriorColor!,row.interiorColor!,row.condition!,row.description!)
    created.push({stockCode:row.stockCode,vehicleId:Number(result.lastInsertRowid)})
  }
  return {applied:true,created,skipped,requiresReview:true,status:'Rascunho',
    note:'Somente novos rascunhos; fotos, alterações existentes, vendas e promoção para Pronto exigem fluxo separado. Nenhum trabalho de publicação criado.'}
}
