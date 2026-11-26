import type { DatabaseSync } from 'node:sqlite'
import { validatedQueryReference } from './commander-query-tools.ts'

export const memoryRetentionDays=30
const maxTurns=6
const maxReferences=4
export type MemoryScope={userId:string;destinationHash:string;revision:number}
type Reference=ReturnType<typeof validatedQueryReference>
type Turn={createdAt:number;references:Reference[]}
function active(db:DatabaseSync,org:number,scope:MemoryScope){
  if(!/^[1-9]\d{0,15}$/.test(scope.userId)||!Number.isSafeInteger(Number(scope.userId))||
    !/^[a-f0-9]{64}$/.test(scope.destinationHash)||!Number.isSafeInteger(scope.revision))return false
  const row=db.prepare('SELECT user_ids ids FROM telegram_commander WHERE organization_id=? AND enabled=1 AND ai_enabled=1 AND memory_enabled=1 AND destination_hash=? AND revision=?').get(org,scope.destinationHash,scope.revision)
  try{const ids:unknown=JSON.parse(String(row?.ids||'[]'));return Array.isArray(ids)&&ids.includes(scope.userId)}catch{return false}
}
function references(raw:unknown):Reference[]{
  if(!Array.isArray(raw))return []
  return raw.slice(0,maxReferences).flatMap(v=>{
    if(!v||typeof v!=='object')return []
    try{return [validatedQueryReference(v.tool,v.arguments)]}catch{return []}
  })
}
export function readCommanderMemory(db:DatabaseSync,org:number,scope:MemoryScope,now=Date.now()):Turn[]{
  if(!active(db,org,scope))return []
  const rows=db.prepare('SELECT created_at createdAt,traces FROM commander_memory WHERE organization_id=? AND telegram_user_id=? AND destination_hash=? AND revision=? AND created_at>=? AND created_at<=? ORDER BY id DESC LIMIT ?').all(org,scope.userId,scope.destinationHash,scope.revision,now-memoryRetentionDays*86400000,now,maxTurns)
  return rows.reverse().flatMap(row=>{
    try{const refs=references(JSON.parse(String(row.traces)));return refs.length?[{createdAt:Number(row.createdAt),references:refs}]:[]}catch{return []}
  })
}
export function rememberCommanderQueries(db:DatabaseSync,org:number,scope:MemoryScope,raw:unknown,now=Date.now()){
  const refs=references(raw)
  if(!refs.length)return false
  db.exec('BEGIN IMMEDIATE')
  try{
    if(!active(db,org,scope)){db.exec('COMMIT');return false}
    db.prepare('INSERT INTO commander_memory(organization_id,telegram_user_id,destination_hash,revision,created_at,traces) VALUES(?,?,?,?,?,?)').run(org,scope.userId,scope.destinationHash,scope.revision,now,JSON.stringify(refs))
    db.prepare('DELETE FROM commander_memory WHERE organization_id=? AND telegram_user_id=? AND id NOT IN (SELECT id FROM commander_memory WHERE organization_id=? AND telegram_user_id=? AND destination_hash=? AND revision=? ORDER BY id DESC LIMIT ?)').run(org,scope.userId,org,scope.userId,scope.destinationHash,scope.revision,maxTurns)
    db.exec('COMMIT');return true
  }catch(error){db.exec('ROLLBACK');throw error}
}
export function clearCommanderMemory(db:DatabaseSync,org:number,userId?:string){
  return Number(userId===undefined?db.prepare('DELETE FROM commander_memory WHERE organization_id=?').run(org).changes:db.prepare('DELETE FROM commander_memory WHERE organization_id=? AND telegram_user_id=?').run(org,userId).changes)
}
export function clearAllCommanderMemory(db:DatabaseSync,org:number){
  db.exec('BEGIN IMMEDIATE')
  try{
    // Invalidate any in-flight query before clearing memory.
    db.prepare('UPDATE telegram_commander SET revision=revision+1 WHERE organization_id=?').run(org)
    const removed=clearCommanderMemory(db,org)
    db.exec('COMMIT');return removed
  }catch(error){db.exec('ROLLBACK');throw error}
}
export function pruneCommanderMemory(db:DatabaseSync,now=Date.now()){
  db.prepare('DELETE FROM commander_memory WHERE id IN (SELECT id FROM commander_memory WHERE created_at<? LIMIT 5000)').run(now-memoryRetentionDays*86400000)
}
export function commanderMemoryCount(db:DatabaseSync,org:number,now=Date.now()){
  return Number(db.prepare('SELECT COUNT(*) n FROM commander_memory m JOIN telegram_commander t ON t.organization_id=m.organization_id AND t.destination_hash=m.destination_hash AND t.revision=m.revision WHERE m.organization_id=? AND t.memory_enabled=1 AND t.enabled=1 AND t.ai_enabled=1 AND m.created_at>=? AND m.created_at<=?').get(org,now-memoryRetentionDays*86400000,now)?.n||0)
}
