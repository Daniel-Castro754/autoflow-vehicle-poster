import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { generateVehicleDescription, resolveAIProviderSettings, type CopyTone, type VehicleInput } from './description-generator.ts'
import { generateVehicleHashtags } from './trending-hashtags.ts'

type Operation = 'manual_autopilot' | 'batch_descriptions'
type Vehicle = {
  id: number; year: number; make: string; model: string; trim: string; price: number
  km: number; status: string; soldAt: string | null; description: string
  exteriorColor: string; transmission: string; fuelType: string; condition: string
  location: string; updatedAt: string
}
type Proposal = {
  vehicleId: number; label: string; original: string; proposed: string
  provider: string; fingerprint: string
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function store(db: DatabaseSync, org: number, user: number, op: Operation, payload: unknown) {
  const id = randomUUID()
  db.prepare("INSERT INTO ai_operation_previews(id,organization_id,user_id,operation,payload,expires_at) VALUES (?,?,?,?,?,datetime('now','+15 minutes'))")
    .run(id, org, user, op, JSON.stringify(payload))
  return id
}

function load(db: DatabaseSync, org: number, user: number, op: Operation, id: string): unknown {
  if (!/^[\da-f-]{36}$/i.test(id)) throw new Error('Identificador da prévia inválido.')
  const row = db.prepare(
    'SELECT payload FROM ai_operation_previews WHERE id=? AND organization_id=? AND user_id=? AND operation=? AND consumed_at IS NULL AND datetime(expires_at)>CURRENT_TIMESTAMP',
  ).get(id, org, user, op) as { payload: string } | undefined
  if (!row) throw new Error('Prévia expirada, já utilizada ou de outro usuário. Gere outra.')
  return JSON.parse(row.payload) as unknown
}

function markUsed(db: DatabaseSync, org: number, user: number, id: string) {
  const result = db.prepare(
    'UPDATE ai_operation_previews SET consumed_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND user_id=? AND consumed_at IS NULL',
  ).run(id, org, user)
  if (result.changes !== 1) throw new Error('Esta prévia já foi aplicada.')
}

const VEHICLE_SQL = 'SELECT v.id,v.year,v.make,v.model,v.trim,v.price,v.km,v.status,v.sold_at soldAt,v.description,v.exterior_color exteriorColor,v.transmission,v.fuel_type fuelType,v.vehicle_condition condition,v.location,v.updated_at updatedAt FROM vehicles v'

function weakDescriptions(db: DatabaseSync, org: number): Vehicle[] {
  return db.prepare(VEHICLE_SQL +
    " WHERE v.organization_id=? AND v.status IN ('Rascunho','Pronto') AND v.sold_at IS NULL AND v.make!='' AND v.model!='' " +
    " AND (LENGTH(TRIM(COALESCE(v.description,'')))<60 OR v.description LIKE '%{ano}%') " +
    " AND NOT EXISTS (SELECT 1 FROM publication_jobs j WHERE j.organization_id=v.organization_id AND j.vehicle_id=v.id AND j.status IN ('pending','filling','error','awaiting_confirmation','completed')) ORDER BY v.id",
  ).all(org) as Vehicle[]
}

function safeToEdit(db: DatabaseSync, org: number, v: Vehicle): boolean {
  if (v.soldAt || !['Rascunho', 'Pronto'].includes(v.status)) return false
  return !db.prepare(
    "SELECT 1 FROM publication_jobs WHERE organization_id=? AND vehicle_id=? AND status IN ('pending','filling','error','awaiting_confirmation','completed') LIMIT 1",
  ).get(org, v.id)
}

export async function prepareBatchDescriptionPreview(db: DatabaseSync, org: number, user: number, tone: CopyTone = 'vendedor') {
  if (!['vendedor', 'profissional', 'amigável', 'direto'].includes(tone))
    throw new Error('Tom de descrição inválido.')
  const candidates = weakDescriptions(db, org)
  const conf = db.prepare('SELECT gemini_api_key geminiApiKey,openai_api_key openaiApiKey,ai_provider aiProvider FROM organization_settings WHERE organization_id=?')
    .get(org) as { geminiApiKey?: string; openaiApiKey?: string; aiProvider?: string } | undefined
  const settings = resolveAIProviderSettings(conf)
  const proposals: Proposal[] = []
  for (const v of candidates.slice(0, 10)) {
    const input: VehicleInput = {
      year:v.year,make:v.make,model:v.model,trim:v.trim,price:v.price,km:v.km,
      exteriorColor:v.exteriorColor,transmission:v.transmission,fuelType:v.fuelType,
      condition:v.condition,location:v.location,
    }
    const generated = await generateVehicleDescription(input, { tone, ...settings })
    const proposed = generated.description + '\n\n' + generateVehicleHashtags(input).join(' ')
    if (proposed.trim()) proposals.push({
      vehicleId:v.id,label:v.year+' '+v.make+' '+v.model,original:v.description || '',
      proposed,provider:generated.provider,fingerprint:sha(v),
    })
  }
  const previewId = proposals.length ? store(db, org, user, 'batch_descriptions', { proposals }) : null
  return { ok:true, previewId, expiresInMinutes:15, totalEligible:candidates.length,
    remainingAfterBatch:Math.max(0,candidates.length-proposals.length),
    proposals:proposals.map(({ fingerprint: _fingerprint, ...item }) => item) }
}

export function applyBatchDescriptionPreview(db: DatabaseSync, org: number, user: number, id: string, selectedIds: number[]) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const payload = load(db, org, user, 'batch_descriptions', id) as { proposals: Proposal[] }
    if (!Array.isArray(selectedIds) || !selectedIds.length || new Set(selectedIds).size !== selectedIds.length ||
      selectedIds.some((vehicleId) => !Number.isSafeInteger(vehicleId) || !payload.proposals.some((p) => p.vehicleId === vehicleId)))
      throw new Error('Selecione as descrições aprovadas na prévia.')
    const chosen = payload.proposals.filter((p) => selectedIds.includes(p.vehicleId))
    for (const p of chosen) {
      const current = db.prepare(VEHICLE_SQL + ' WHERE v.organization_id=? AND v.id=?')
        .get(org, p.vehicleId) as Vehicle | undefined
      if (!current || !safeToEdit(db, org, current) || sha(current) !== p.fingerprint)
        throw new Error('Estoque alterado desde a prévia. Nada foi aplicado; gere uma nova.')
    }
    for (const p of chosen)
      db.prepare('UPDATE vehicles SET description=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id=?')
        .run(p.proposed,org,p.vehicleId)
    markUsed(db,org,user,id)
    db.exec('COMMIT')
    return {ok:true,updated:chosen.length}
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function autopilotSnapshot(db: DatabaseSync, org: number) {
  const settings = db.prepare('SELECT daily_limit,execution_interval_minutes FROM organization_settings WHERE organization_id=?').get(org)
  const accounts = db.prepare('SELECT id,status,browser_profile FROM social_accounts WHERE organization_id=? ORDER BY id').all(org) as Array<{status:string}>
  const vehicles = db.prepare(
    "SELECT v.id,v.year,v.make,v.model,v.price,v.km,v.description,v.status,v.updated_at,(SELECT COUNT(*) FROM vehicle_images i WHERE i.organization_id=v.organization_id AND i.vehicle_id=v.id) photoCount FROM vehicles v WHERE v.organization_id=? AND v.status='Pronto' AND v.sold_at IS NULL ORDER BY v.id",
  ).all(org) as Array<{id:number;year:number;make:string;model:string;photoCount:number}>
  const jobs = db.prepare('SELECT id,vehicle_id vehicleId,social_account_id accountId,status,scheduled_at FROM publication_jobs WHERE organization_id=? ORDER BY id')
    .all(org) as Array<{vehicleId:number;status:string}>
  const used = new Set(jobs.filter((j) =>
    ['pending','filling','error','awaiting_confirmation','completed'].includes(j.status)).map((j) => j.vehicleId))
  const candidates = vehicles.filter((v) => !used.has(v.id) && v.photoCount > 0)
  return { digest:sha({settings,accounts,vehicles,jobs}), candidates,
    connected:accounts.filter((a)=>a.status==='connected').length }
}

export function prepareAutopilotPreview(db: DatabaseSync, org: number, user: number) {
  const current = autopilotSnapshot(db,org)
  const candidates = current.candidates.slice(0,20)
  const previewId = current.connected && candidates.length
    ? store(db,org,user,'manual_autopilot',{digest:current.digest}) : null
  return {ok:true,previewId,expiresInMinutes:15,connectedProfiles:current.connected,
    potentialVehicles:candidates.map((v)=>({id:v.id,title:v.year+' '+v.make+' '+v.model})),
    note:'Prévia de candidatos; a execução valida novamente crédito de publicação, cadastro, fotos e duplicidades.'}
}

export function consumeAutopilotPreview(db: DatabaseSync,org:number,user:number,id:string) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const stored = load(db,org,user,'manual_autopilot',id) as {digest:string}
    if (autopilotSnapshot(db,org).digest !== stored.digest)
      throw new Error('Estoque, perfis ou fila foram alterados. Gere nova prévia antes de executar.')
    markUsed(db,org,user,id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
