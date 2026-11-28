import type { DatabaseSync } from 'node:sqlite'
import { normalizeInventoryIdentifier, validateInventoryIdentifiers } from './vehicle-import.ts'
import { vehicleOptions } from './vehicle-input.ts'

export class StockSyncInputError extends Error {}
type SourceRow = { stockCode:string; vin?:string; year:number; make:string; model:string; trim?:string; price:number; km:number }
type LocalRow = SourceRow & { id:number; status:string; soldAt:string|null; protectedWork:number }
type Category = 'new'|'changed'|'unchanged'|'conflict'
type Entry = {stockCode:string; category:Category; vehicleId?:number; changedFields?:string[]; reason?:string}
const fields=['year','make','model','trim','price','km'] as const
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
  if(Object.keys(v).some(k=>!['stockCode','vin',...fields].includes(k)))return fail('Campo de veículo não permitido nesta prévia.')
  const stockCode=identifier(v.stockCode)
  const vin=v.vin===undefined?undefined:identifier(v.vin,false)
  if(validateInventoryIdentifiers(stockCode,vin||''))return fail('Identificador de estoque/chassi inválido.')
  const make=text(v.make,100)
  if(!vehicleOptions.make.has(make))return fail('Fabricante fora do catálogo.')
  return {stockCode,vin,year:numeric(v.year,1900,new Date().getFullYear()+1,true),make,model:text(v.model,150),
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
  if(Object.keys(v).some(k=>!['version','source','sourceState','rows'].includes(k))||v.version!==1||
    typeof v.source!=='string'||!['sheets','activepieces','manual'].includes(v.source)||
    typeof v.sourceState!=='string'||!['complete','partial','failed'].includes(v.sourceState)||
    !Array.isArray(v.rows)||v.rows.length>maxRows||(v.sourceState==='failed'&&v.rows.length))return fail('Envelope de sincronização inválido.')
  const rows=v.rows.map(parseRow)
  const local=db.prepare(`SELECT v.id,v.stock_code stockCode,v.vin,v.year,v.make,v.model,v.trim,v.price,v.km,v.status,v.sold_at soldAt,
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
    if(!current)return {...base,category:'new'}
    if(row.vin&&current.vin&&row.vin!==normalizeInventoryIdentifier(current.vin))return {...base,vehicleId:current.id,category:'conflict',reason:'vin_mismatch'}
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
  return {version:1,source:v.source,sourceState:v.sourceState,readOnly:true,sourceRows:rows.length,counts,entries,
    absence:{comparable:absenceComparable,count:absenceComparable?notSeen.length:null,exampleVehicleIds:notSeen.slice(0,30).map(row=>row.id)},
    note:'Prévia dos campos básicos fornecidos; não comprova a origem ou completude declarada. Ausência não significa venda, exclusão ou autorização para alterar o estoque. Nenhuma alteração foi executada.'}
}
