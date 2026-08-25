import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync, timingSafeEqual, createHmac, createHash } from 'node:crypto'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const configuredSecret = process.env.AUTH_SECRET?.trim()
if (!configuredSecret || configuredSecret.length < 32) throw new Error('AUTH_SECRET deve ter pelo menos 32 caracteres.')
const secret=configuredSecret
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(root, 'data')
mkdirSync(dataDir, { recursive: true })
const uploadsDir = join(dataDir, 'uploads')
mkdirSync(uploadsDir, { recursive: true })
const db = new DatabaseSync(join(dataDir, 'autoflow.db'))
const port = Number(process.env.PORT || 3333)

db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'seller',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
  );
  CREATE TABLE IF NOT EXISTS social_accounts (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    label TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'facebook', status TEXT NOT NULL DEFAULT 'not_connected',
    browser_profile TEXT, last_seen_at TEXT,
    FOREIGN KEY (organization_id) REFERENCES organizations(id), FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, year INTEGER NOT NULL,
    make TEXT NOT NULL, model TEXT NOT NULL, trim TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0,
    km INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT '#dde3e2', status TEXT NOT NULL DEFAULT 'Rascunho',
    assigned_user_id INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id), FOREIGN KEY (assigned_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS publication_jobs (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL,
    social_account_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', result_url TEXT, error_code TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id), FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    FOREIGN KEY (social_account_id) REFERENCES social_accounts(id)
  );
  CREATE TABLE IF NOT EXISTS organization_settings (
    organization_id INTEGER PRIMARY KEY, default_location TEXT NOT NULL DEFAULT '',
    daily_limit INTEGER NOT NULL DEFAULT 10, require_confirmation INTEGER NOT NULL DEFAULT 1,
    description_template TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
  );
  CREATE TABLE IF NOT EXISTS vehicle_images (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL,
    file_name TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id), FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
  );
  CREATE TABLE IF NOT EXISTS marketplace_groups (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
    group_key TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0, last_found_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
  );
  CREATE TABLE IF NOT EXISTS publication_job_events (
    id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, publication_job_id INTEGER NOT NULL,
    event_type TEXT NOT NULL, from_account_id INTEGER, to_account_id INTEGER, created_by INTEGER,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id), FOREIGN KEY (publication_job_id) REFERENCES publication_jobs(id),
    FOREIGN KEY (from_account_id) REFERENCES social_accounts(id), FOREIGN KEY (to_account_id) REFERENCES social_accounts(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
`)

function ensureColumn(table:string,column:string,definition:string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>
  if (!columns.some(item=>item.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
ensureColumn('vehicles','vehicle_type',"TEXT NOT NULL DEFAULT 'Carro/picape'")
ensureColumn('vehicles','location',"TEXT NOT NULL DEFAULT ''")
ensureColumn('vehicles','transmission',"TEXT NOT NULL DEFAULT 'Automático'")
ensureColumn('vehicles','fuel_type',"TEXT NOT NULL DEFAULT 'Flex'")
ensureColumn('vehicles','body_type',"TEXT NOT NULL DEFAULT 'Sedã'")
ensureColumn('vehicles','exterior_color',"TEXT NOT NULL DEFAULT ''")
ensureColumn('vehicles','interior_color',"TEXT NOT NULL DEFAULT ''")
ensureColumn('vehicles','description',"TEXT NOT NULL DEFAULT ''")
ensureColumn('vehicles','vehicle_condition',"TEXT NOT NULL DEFAULT ''")
ensureColumn('publication_jobs','fill_report',"TEXT NOT NULL DEFAULT ''")
ensureColumn('publication_jobs','extension_version',"TEXT NOT NULL DEFAULT ''")
ensureColumn('publication_jobs','started_at','TEXT')
ensureColumn('publication_jobs','filled_at','TEXT')
ensureColumn('publication_jobs','removed_at','TEXT')
ensureColumn('publication_jobs','extension_visible','INTEGER NOT NULL DEFAULT 1')
ensureColumn('publication_jobs','attempt_count','INTEGER NOT NULL DEFAULT 0')
ensureColumn('publication_jobs','queue_priority','INTEGER NOT NULL DEFAULT 0')
ensureColumn('publication_jobs','paused','INTEGER NOT NULL DEFAULT 0')
ensureColumn('publication_jobs','scheduled_at','TEXT')
ensureColumn('publication_jobs','lease_token','TEXT')
ensureColumn('publication_jobs','lease_owner','TEXT')
ensureColumn('publication_jobs','lease_expires_at','TEXT')
ensureColumn('publication_job_events','details',"TEXT NOT NULL DEFAULT '{}'")
ensureColumn('vehicle_images','content_hash',"TEXT NOT NULL DEFAULT ''")
ensureColumn('vehicles','sold_at','TEXT')
ensureColumn('organization_settings','auto_advance','INTEGER NOT NULL DEFAULT 0')
ensureColumn('organization_settings','fill_groups','INTEGER NOT NULL DEFAULT 0')
ensureColumn('organization_settings','target_groups',"TEXT NOT NULL DEFAULT '[]'")
ensureColumn('organization_settings','auto_publish','INTEGER NOT NULL DEFAULT 0')
ensureColumn('organization_settings','stuck_timeout_minutes','INTEGER NOT NULL DEFAULT 15')
db.prepare('UPDATE publication_jobs SET queue_priority=id WHERE queue_priority=0').run()
db.exec('CREATE INDEX IF NOT EXISTS idx_publication_job_events_timeline ON publication_job_events (organization_id,publication_job_id,created_at,id)')
db.exec('CREATE INDEX IF NOT EXISTS idx_vehicle_images_content_hash ON vehicle_images (organization_id,content_hash,vehicle_id)')
for(const image of db.prepare("SELECT id,file_name fileName FROM vehicle_images WHERE content_hash='' OR content_hash IS NULL").all() as Array<{id:number;fileName:string}>){
  const path=join(uploadsDir,image.fileName)
  if(existsSync(path))db.prepare('UPDATE vehicle_images SET content_hash=? WHERE id=?').run(createHash('sha256').update(readFileSync(path)).digest('hex'),image.id)
}

function recordJobEvent(organizationId:number,publicationJobId:number,eventType:string,createdBy:number|null=null,details:Record<string,unknown>={},fromAccountId:number|null=null,toAccountId:number|null=null) {
  let serialized='{}'
  try { serialized=JSON.stringify(details).slice(0,8000) } catch { /* detalhes opcionais */ }
  db.prepare(`INSERT INTO publication_job_events (organization_id,publication_job_id,event_type,from_account_id,to_account_id,created_by,details)
    VALUES (?,?,?,?,?,?,?)`).run(organizationId,publicationJobId,eventType,fromAccountId,toAccountId,createdBy,serialized)
}

function publicationDuplicateRisk(organizationId:number,vehicleId:number,excludeJobId=0) {
  const sameVehicle=db.prepare(`SELECT j.id jobId,j.status,COALESCE(a.label,'Perfil não definido') accountLabel
    FROM publication_jobs j LEFT JOIN social_accounts a ON a.id=j.social_account_id
    WHERE j.organization_id=? AND j.vehicle_id=? AND j.id!=? AND j.status IN ('pending','filling','error','awaiting_confirmation','completed')
    ORDER BY CASE j.status WHEN 'completed' THEN 0 WHEN 'filling' THEN 1 ELSE 2 END,j.updated_at DESC LIMIT 1`).get(organizationId,vehicleId,excludeJobId) as Record<string,unknown>|undefined
  if(sameVehicle)return{type:'same_vehicle',...sameVehicle,message:sameVehicle.status==='completed'?`Este veículo já possui um anúncio publicado no perfil ${sameVehicle.accountLabel}. Marque o anúncio anterior como removido antes de publicar novamente.`:`Este veículo já possui o trabalho #${sameVehicle.jobId} no perfil ${sameVehicle.accountLabel}. Retome o trabalho existente em vez de criar outro.`}
  const sharedPhoto=db.prepare(`SELECT other.vehicle_id vehicleId,v.year,v.make,v.model,j.id jobId,j.status,COALESCE(a.label,'Perfil não definido') accountLabel,
      COUNT(DISTINCT target.content_hash) matchedPhotos
    FROM vehicle_images target JOIN vehicle_images other ON other.organization_id=target.organization_id
      AND other.content_hash=target.content_hash AND other.vehicle_id!=target.vehicle_id
    JOIN vehicles v ON v.id=other.vehicle_id JOIN publication_jobs j ON j.vehicle_id=other.vehicle_id AND j.organization_id=target.organization_id
    LEFT JOIN social_accounts a ON a.id=j.social_account_id
    WHERE target.organization_id=? AND target.vehicle_id=? AND target.content_hash!=''
      AND j.status IN ('pending','filling','error','awaiting_confirmation','completed')
    GROUP BY other.vehicle_id,j.id ORDER BY matchedPhotos DESC,j.updated_at DESC LIMIT 1`).get(organizationId,vehicleId) as Record<string,unknown>|undefined
  if(sharedPhoto)return{type:'shared_photo',...sharedPhoto,message:`As fotos coincidem com o trabalho #${sharedPhoto.jobId} (${sharedPhoto.year} ${sharedPhoto.make} ${sharedPhoto.model}) no perfil ${sharedPhoto.accountLabel}. Use o cadastro existente ou remova o anúncio anterior antes de continuar.`}
  return null
}

function parseGroupTarget(value:unknown) {
  const raw=String(value||'').trim(),parts=raw.split('|').map(item=>item.trim()).filter(Boolean)
  const url=parts.find(item=>/^https?:\/\/(?:www\.|m\.)?facebook\.com\/groups\//i.test(item))||''
  const name=parts.find(item=>item!==url)||(!url?raw:'')
  const key=(url.match(/facebook\.com\/groups\/([^/?#]+)/i)?.[1]||'').trim()
  return {name:name||key,url,groupKey:key}
}
function validateGroupTarget(value:unknown) {
  if(typeof value==='string'){
    const parts=value.split('|').map((item:string)=>item.trim()).filter(Boolean)
    const possibleUrl=parts.find((item:string)=>/^https?:\/\//i.test(item))||''
    return Boolean(parseGroupTarget(value).name)&&(!possibleUrl||/^https?:\/\/(?:www\.|m\.)?facebook\.com\/groups\/[^/?#]+/i.test(possibleUrl))
  }
  if(!value||typeof value!=='object')return false
  const record=value as Record<string,unknown>
  const name=String(record.name||'').trim(),url=String(record.url||'').trim()
  return Boolean(name)&&(!url||/^https?:\/\/(?:www\.|m\.)?facebook\.com\/groups\/[^/?#]+/i.test(url))
}
function groupTarget(group:{name:string;url:string}) { return group.url?`${group.name} | ${group.url}`:group.name }
function marketplaceGroups(organizationId:number,activeOnly=false) {
  return db.prepare(`SELECT id,name,url,group_key groupKey,active,priority,success_count successCount,failure_count failureCount,last_found_at lastFoundAt
    FROM marketplace_groups WHERE organization_id=?${activeOnly?' AND active=1':''} ORDER BY priority,id`).all(organizationId) as Array<{id:number;name:string;url:string;groupKey:string;active:number;priority:number;successCount:number;failureCount:number;lastFoundAt?:string}>
}
function replaceMarketplaceGroups(organizationId:number,values:unknown[]) {
  const existing=marketplaceGroups(organizationId),byId=new Map(existing.map(group=>[group.id,group]))
  const incoming=values.slice(0,20).map((value,index)=>{
    if(typeof value==='string')return {...parseGroupTarget(value),id:0,active:true,priority:index+1}
    const record=value&&typeof value==='object'?value as Record<string,unknown>:{}
    const parsed=parseGroupTarget(record.url?`${record.name||''} | ${record.url}`:record.name)
    return {...parsed,id:Number(record.id)||0,active:record.active!==false,priority:Number(record.priority)||index+1}
  }).filter(group=>group.name)
  const incomingIds=new Set(incoming.map(group=>group.id).filter(Boolean))
  for(const group of existing)if(!incomingIds.has(group.id))db.prepare('DELETE FROM marketplace_groups WHERE id=? AND organization_id=?').run(group.id,organizationId)
  for(const group of incoming){
    if(group.id&&byId.has(group.id))db.prepare(`UPDATE marketplace_groups SET name=?,url=?,group_key=?,active=?,priority=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
      .run(group.name,group.url,group.groupKey,group.active?1:0,group.priority,group.id,organizationId)
    else db.prepare(`INSERT INTO marketplace_groups (organization_id,name,url,group_key,active,priority) VALUES (?,?,?,?,?,?)`)
      .run(organizationId,group.name,group.url,group.groupKey,group.active?1:0,group.priority)
  }
  const activeTargets=marketplaceGroups(organizationId,true).map(groupTarget)
  db.prepare('UPDATE organization_settings SET target_groups=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=?').run(JSON.stringify(activeTargets),organizationId)
  return marketplaceGroups(organizationId)
}

function hashPassword(password:string) {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}
function verifyPassword(password:string, stored:string) {
  const [salt, expected] = stored.split(':')
  const actual = scryptSync(password, salt, 64)
  return expected?.length === 128 && timingSafeEqual(actual, Buffer.from(expected, 'hex'))
}
function sign(payload:object) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}
function readToken(req:IncomingMessage) {
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const valid = createHmac('sha256', secret).update(body).digest('base64url')
  if (sig.length !== valid.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(valid))) return null
  try { const value = JSON.parse(Buffer.from(body, 'base64url').toString()); return value.exp > Date.now() ? value : null } catch { return null }
}
async function jsonBody(req:IncomingMessage) {
  const chunks:Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const configuredOrigins=new Set((process.env.CORS_ORIGINS||'http://localhost:5173,http://127.0.0.1:5173').split(',').map(value=>value.trim()).filter(Boolean))
function applyCors(req:IncomingMessage,res:ServerResponse) {
  const origin=String(req.headers.origin||'')
  const allowed=!origin||configuredOrigins.has(origin)||/^chrome-extension:\/\/[a-p]{32}$/.test(origin)
  if(origin)res.setHeader('Vary','Origin')
  if(origin&&allowed)res.setHeader('Access-Control-Allow-Origin',origin)
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, DELETE, OPTIONS')
  return allowed
}
function send(res:ServerResponse, status:number, data:unknown) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

const vehicleOptions = {
  vehicleType:new Set(['Carro/picape','Motocicleta','Veículos para esportes','Trailer','Reboque','Barco','Comercial/industrial','Outro']),
  make:new Set([
    'AM General','Agrale','Alfa Romeo','Aston Martin','Audi','BMW','Bentley','BYD','Cadillac','Caoa Chery','Chery','Chevrolet','Chrysler','Citroën','Cross Lander','Cupra','DS','Daewoo','Daihatsu','Dodge','Effa','Ferrari','Fiat','Ford','Geely','GWM','Honda','Hyundai','Iveco','JAC','Jaecoo','Jaguar','Jeep','Kia','Lamborghini','Land Rover','Lexus','Lifan','Maserati','Mazda','Mercedes-Benz','Mini','Mitsubishi','Nissan','Omoda','Peugeot','Porsche','RAM','Renault','Rolls-Royce','Seat','Smart','SsangYong','Subaru','Suzuki','Tesla','Toyota','Troller','Volkswagen','Volvo','Outra',
  ]),
  transmission:new Set(['Automático','Manual','Automatizado']),
  fuelType:new Set(['Flex','Gasolina','Diesel','Elétrico','Híbrido','Etanol','GNV','Outro']),
  bodyType:new Set(['Conversível','Cupê','Hatch','Minivan','Picape','Sedã','SUV','Perua','Van','Outro']),
  condition:new Set(['Excelente','Muito bom','Bom','Regular','Ruim']),
  color:new Set(['Preto','Azul','Marrom','Dourado','Verde','Cinza','Rosa','Roxo','Vermelho','Prateado','Laranja','Branco','Amarelo','Carvão','Off-white','Bronze','Bege','Bordô']),
  status:new Set(['Rascunho','Pronto','Publicado','Atenção','Vendido']),
}

function validateVehicleBody(body:Record<string,unknown>) {
  const year=Number(body.year), price=Number(body.price), km=Number(body.km)
  if (!Number.isInteger(year)||year<1900||year>new Date().getFullYear()+1) return 'Selecione um ano válido.'
  if (!vehicleOptions.make.has(String(body.make))) return 'Selecione uma fabricante da lista.'
  if (!String(body.model||'').trim()) return 'O modelo é obrigatório.'
  if (!String(body.location||'').trim()) return 'A localização é obrigatória.'
  if (!Number.isFinite(price)||price<=0) return 'Informe um preço maior que zero.'
  if (!Number.isFinite(km)||km<0) return 'Informe uma quilometragem válida.'
  if (!vehicleOptions.vehicleType.has(String(body.vehicleType))) return 'Selecione um tipo de veículo válido.'
  if (!vehicleOptions.transmission.has(String(body.transmission))) return 'Selecione um câmbio válido.'
  if (!vehicleOptions.fuelType.has(String(body.fuelType))) return 'Selecione um combustível válido.'
  if (!vehicleOptions.bodyType.has(String(body.bodyType))) return 'Selecione uma carroceria válida.'
  if (!vehicleOptions.condition.has(String(body.condition))) return 'Selecione uma condição válida.'
  if (!vehicleOptions.color.has(String(body.exteriorColor))) return 'Selecione uma cor externa da lista.'
  if (!vehicleOptions.color.has(String(body.interiorColor))) return 'Selecione uma cor interna da lista.'
  if (!vehicleOptions.status.has(String(body.status||'Rascunho'))) return 'Selecione um status válido.'
  if (!String(body.description||'').trim()) return 'A descrição é obrigatória.'
  return ''
}

function userById(id:number) { return db.prepare('SELECT id, organization_id organizationId, name, email, role FROM users WHERE id = ?').get(id) }
function allowedExtensionAccount(accountId:number,auth:{userId:number;organizationId:number}) {
  const current = userById(auth.userId) as {role?:string}|undefined
  return current?.role==='admin'
    ? db.prepare(`SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.user_id userId,u.name owner
        FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.organization_id=?`).get(accountId,auth.organizationId)
    : db.prepare(`SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.user_id userId,u.name owner
        FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.organization_id=? AND a.user_id=?`).get(accountId,auth.organizationId,auth.userId)
}

if (!(db.prepare('SELECT id FROM users LIMIT 1').get())) {
  const adminName=String(process.env.INITIAL_ADMIN_NAME||'Administrador').trim()
  const adminEmail=String(process.env.INITIAL_ADMIN_EMAIL||'').trim().toLowerCase()
  const adminPassword=String(process.env.INITIAL_ADMIN_PASSWORD||'')
  if(!adminName||!adminEmail.includes('@')||adminPassword.length<12)throw new Error('Banco vazio: configure INITIAL_ADMIN_EMAIL e INITIAL_ADMIN_PASSWORD (mínimo de 12 caracteres).')
  const org = db.prepare('INSERT INTO organizations (name) VALUES (?)').run(String(process.env.INITIAL_ORGANIZATION_NAME||'AutoFlow').trim()||'AutoFlow')
  const orgId = Number(org.lastInsertRowid)
  const admin = db.prepare('INSERT INTO users (organization_id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run(orgId,adminName,adminEmail,hashPassword(adminPassword),'admin')
  const adminId = Number(admin.lastInsertRowid)
  const rows = [
    [2022,'Toyota','Corolla','XEi 2.0',119900,42500,adminId,'Pronto','#dce8ef','São Paulo, SP','2022 Toyota Corolla XEi 2.0 com 42.500 km. Único dono, revisões em dia.'],
    [2021,'Jeep','Compass','Longitude',134500,51820,adminId,'Publicado','#dedbd3','São Paulo, SP','2021 Jeep Compass Longitude com 51.820 km. Completo, pneus novos.'],
    [2023,'Volkswagen','T-Cross','Comfortline',128900,22300,adminId,'Rascunho','#d9e2e6','São Paulo, SP','2023 Volkswagen T-Cross Comfortline com 22.300 km.'],
    [2020,'Honda','Civic','Touring',139990,68100,adminId,'Atenção','#e7e4de','São Paulo, SP','2020 Honda Civic Touring com 68.100 km. Revisar documentação antes de publicar.'],
    [2024,'Chevrolet','Tracker','Premier',154900,8900,adminId,'Pronto','#d9e0df','São Paulo, SP','2024 Chevrolet Tracker Premier com 8.900 km. Seminovo, garantia de fábrica.'],
  ]
  const insert = db.prepare('INSERT INTO vehicles (organization_id,year,make,model,trim,price,km,assigned_user_id,status,color,location,description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const row of rows) insert.run(orgId,...row)
}
db.exec(`INSERT OR IGNORE INTO organization_settings (organization_id,default_location,daily_limit,require_confirmation,description_template)
  SELECT id,'São Paulo, SP',10,1,'{ano} {marca} {modelo} {versao} com {km} km. Entre em contato para consultar disponibilidade.' FROM organizations`)
for(const organization of db.prepare('SELECT id FROM organizations').all() as Array<{id:number}>){
  if(!marketplaceGroups(organization.id).length){
    const settings=db.prepare('SELECT target_groups targetGroups FROM organization_settings WHERE organization_id=?').get(organization.id) as {targetGroups?:string}|undefined
    try{const legacy=JSON.parse(String(settings?.targetGroups||'[]'));if(Array.isArray(legacy)&&legacy.length)replaceMarketplaceGroups(organization.id,legacy)}catch{/* configuração antiga inválida */}
  }
}
// Repairs values written by an early Windows encoding issue in the development seed.
db.prepare("UPDATE organizations SET name='AutoPrime Veículos' WHERE name='AutoPrime Ve'||char(65533)||'culos'").run()
db.prepare("UPDATE organization_settings SET default_location='São Paulo, SP' WHERE default_location='S'||char(65533)||'o Paulo, SP'").run()
db.prepare("UPDATE vehicles SET vehicle_type='Carro/picape' WHERE vehicle_type='Carro/Caminhonete'").run()
db.prepare("UPDATE vehicles SET vehicle_type='Outro' WHERE vehicle_type='Outro veículo'").run()
db.prepare("UPDATE vehicles SET exterior_color='Prateado' WHERE exterior_color='Prata'").run()
db.prepare("UPDATE vehicles SET interior_color='Preto' WHERE interior_color='' AND exterior_color!=''").run()

createServer(async (req, res) => {
  const originAllowed=applyCors(req,res)
  if (req.method === 'OPTIONS') return originAllowed?send(res,204,null):send(res,403,{error:'Origem não permitida.'})
  if(!originAllowed)return send(res,403,{error:'Origem não permitida.'})
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    const uploadFile = url.pathname.match(/^\/uploads\/([a-f0-9]{24}\.(?:jpg|jpeg|png|webp))$/)
    if (req.method === 'GET' && uploadFile) {
      const path = join(uploadsDir,uploadFile[1])
      if (!existsSync(path)) return send(res,404,{error:'Imagem não encontrada.'})
      const ext = uploadFile[1].split('.').pop()
      const mime = ext==='png'?'image/png':ext==='webp'?'image/webp':'image/jpeg'
      res.writeHead(200,{'Content-Type':mime,'Cache-Control':'public, max-age=3600'})
      return res.end(readFileSync(path))
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res,200,{ok:true})
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { email, password } = await jsonBody(req) as {email?:string,password?:string}
      const row = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email || '') as Record<string,unknown> | undefined
      if (!row || !verifyPassword(password || '', String(row.password_hash))) return send(res,401,{error:'E-mail ou senha inválidos.'})
      const user = userById(Number(row.id)); return send(res,200,{token:sign({userId:row.id,organizationId:row.organization_id}),user})
    }
    const auth = readToken(req)
    if (!auth) return send(res,401,{error:'Sessão inválida ou expirada.'})
    if (req.method === 'GET' && url.pathname === '/api/me') return send(res,200,{user:userById(auth.userId)})
    if (req.method === 'GET' && url.pathname === '/api/vehicles') {
      const rows = db.prepare(`SELECT v.id,v.year,v.make,v.model,v.trim,v.price,v.km,v.color,v.status,
        v.vehicle_type vehicleType,v.location,v.transmission,v.fuel_type fuelType,v.body_type bodyType,
        v.exterior_color exteriorColor,v.interior_color interiorColor,v.vehicle_condition condition,v.description,v.sold_at soldAt,
        COALESCE(u.name,'Não atribuído') seller,
        CASE WHEN u.name IS NULL THEN '—' ELSE substr(u.name,1,1)||substr(u.name,instr(u.name,' ')+1,1) END initials,
        v.updated_at updatedAt,(SELECT COUNT(*) FROM vehicle_images i WHERE i.vehicle_id=v.id) imageCount,
        (SELECT 'http://127.0.0.1:3333/uploads/'||i.file_name FROM vehicle_images i WHERE i.vehicle_id=v.id ORDER BY i.position,i.id LIMIT 1) thumbnailUrl,
        (SELECT COUNT(*) FROM publication_jobs j WHERE j.vehicle_id=v.id AND j.status='completed') pendingRemovalCount
        FROM vehicles v LEFT JOIN users u ON u.id=v.assigned_user_id
        WHERE v.organization_id=? ORDER BY v.updated_at DESC`).all(auth.organizationId)
      return send(res,200,{vehicles:rows})
    }
    if (req.method === 'GET' && url.pathname === '/api/extension/accounts') {
      const current = userById(auth.userId) as {role?:string}|undefined
      const accounts = current?.role==='admin'
        ? db.prepare(`SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.user_id userId,u.name owner
            FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.organization_id=? ORDER BY u.name,a.label`).all(auth.organizationId)
        : db.prepare(`SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.user_id userId,u.name owner
            FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.organization_id=? AND a.user_id=? ORDER BY a.label`).all(auth.organizationId,auth.userId)
      return send(res,200,{accounts})
    }
    if (req.method === 'GET' && url.pathname === '/api/extension/queue') {
      const accountId=Number(url.searchParams.get('accountId'))
      const account=allowedExtensionAccount(accountId,auth)
      if (!account) return send(res,403,{error:'Selecione um perfil do Brave associado a este usuário.'})
      db.prepare('UPDATE social_accounts SET last_seen_at=CURRENT_TIMESTAMP,status=? WHERE id=? AND organization_id=?').run('connected',accountId,auth.organizationId)
      const jobs = db.prepare(`SELECT j.id jobId,j.vehicle_id vehicleId,j.status jobStatus,j.error_code errorCode,j.queue_priority queuePriority,j.scheduled_at scheduledAt,j.updated_at updatedAt,
        CASE WHEN j.lease_expires_at IS NOT NULL AND datetime(j.lease_expires_at)>CURRENT_TIMESTAMP THEN 1 ELSE 0 END locked,
        v.year,v.make,v.model,v.trim,v.price,v.km,v.status vehicleStatus,
        (SELECT COUNT(*) FROM vehicle_images i WHERE i.vehicle_id=v.id) imageCount,
        COALESCE(u.name,'Não atribuído') seller,a.label accountLabel
        FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id
        JOIN social_accounts a ON a.id=j.social_account_id LEFT JOIN users u ON u.id=v.assigned_user_id
        WHERE j.organization_id=? AND j.social_account_id=? AND j.extension_visible=1 AND j.paused=0 AND (j.scheduled_at IS NULL OR datetime(j.scheduled_at)<=CURRENT_TIMESTAMP) AND j.status IN ('pending','filling','error','awaiting_confirmation')
        ORDER BY CASE j.status WHEN 'filling' THEN 0 ELSE 1 END,j.queue_priority,j.created_at`).all(auth.organizationId,accountId)
      const settings=db.prepare(`SELECT auto_advance autoAdvance,fill_groups fillGroups,target_groups targetGroups,auto_publish autoPublish
        FROM organization_settings WHERE organization_id=?`).get(auth.organizationId) as Record<string,unknown>|undefined
      let targetGroups:string[]=[]
      try { const parsed=JSON.parse(String(settings?.targetGroups||'[]')); if(Array.isArray(parsed))targetGroups=parsed.map(String) } catch { /* lista antiga inválida */ }
      const configuredGroups=marketplaceGroups(auth.organizationId,true)
      if(configuredGroups.length)targetGroups=configuredGroups.map(groupTarget)
      return send(res,200,{account,jobs,automation:{autoAdvance:Boolean(settings?.autoAdvance),fillGroups:Boolean(settings?.fillGroups),targetGroups,autoPublish:Boolean(settings?.autoPublish)}})
    }
    const extensionPrepare = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/prepare$/)
    if (req.method === 'POST' && extensionPrepare) {
      const b=await jsonBody(req) as {accountId?:number;instanceId?:string}
      const accountId=Number(b.accountId)
      const instanceId=String(b.instanceId||'').trim().slice(0,100)
      if(!/^[a-zA-Z0-9_-]{12,100}$/.test(instanceId))return send(res,400,{error:'A extensão precisa atualizar sua identificação local antes de iniciar.'})
      if (!allowedExtensionAccount(accountId,auth)) return send(res,403,{error:'Este perfil do Brave não está disponível para o usuário conectado.'})
      const job = db.prepare(`SELECT j.id,j.vehicle_id vehicleId,j.status,j.paused,j.scheduled_at scheduledAt,j.lease_expires_at leaseExpiresAt,j.fill_report fillReport FROM publication_jobs j
        WHERE j.id=? AND j.organization_id=? AND j.social_account_id=?`).get(Number(extensionPrepare[1]),auth.organizationId,accountId) as {id:number;vehicleId:number;status:string;paused:number;scheduledAt?:string;leaseExpiresAt?:string;fillReport?:string}|undefined
      if (!job) return send(res,404,{error:'Trabalho não encontrado para este perfil.'})
      if (job.paused) return send(res,409,{error:'Este trabalho está pausado no painel.'})
      if (job.scheduledAt&&Date.parse(job.scheduledAt)>Date.now()) return send(res,409,{error:'Este trabalho ainda não chegou ao horário agendado.'})
      if (!['pending','filling','error','awaiting_confirmation'].includes(job.status)) return send(res,409,{error:'Este trabalho não está disponível para preenchimento.'})
      if(job.leaseExpiresAt&&Date.parse(job.leaseExpiresAt.replace(' ','T')+'Z')>Date.now())return send(res,409,{error:'Este trabalho já está aberto em outra aba ou instância da extensão.'})
      let previousReport:Record<string,unknown>={}
      try{previousReport=job.fillReport?JSON.parse(job.fillReport):{}}catch{/* relatório antigo inválido */}
      if(job.status==='awaiting_confirmation'&&previousReport.publishAttempted&&!previousReport.published)return send(res,409,{error:'O Facebook recebeu um clique em Publicar, mas não confirmou o resultado. Verifique Seus classificados e confirme no painel antes de tentar novamente.'})
      const duplicateRisk=publicationDuplicateRisk(auth.organizationId,job.vehicleId,job.id)
      if(duplicateRisk){recordJobEvent(auth.organizationId,job.id,'duplicate_blocked',null,duplicateRisk);return send(res,409,{error:duplicateRisk.message,duplicate:duplicateRisk})}
      const vehicle = db.prepare(`SELECT v.id,v.year,v.make,v.model,v.trim,v.price,v.km,v.status,
        v.vehicle_type vehicleType,v.location,v.transmission,v.fuel_type fuelType,v.body_type bodyType,v.exterior_color exteriorColor,v.interior_color interiorColor,v.vehicle_condition condition,
        printf('%d %s %s %s',v.year,v.make,v.model,v.trim) title,
        CASE WHEN length(v.description)>0 THEN v.description ELSE printf('%d %s %s %s com %d km. Entre em contato para consultar disponibilidade e condições.',v.year,v.make,v.model,v.trim,v.km) END description
        FROM vehicles v WHERE v.id=? AND v.organization_id=?`).get(job.vehicleId,auth.organizationId) as Record<string,unknown>|undefined
      if (!vehicle) return send(res,404,{error:'Veículo não encontrado.'})
      const images = db.prepare(`SELECT 'http://127.0.0.1:3333/uploads/'||file_name url,original_name name,mime_type mimeType FROM vehicle_images WHERE vehicle_id=? AND organization_id=? ORDER BY position,id LIMIT 20`).all(job.vehicleId,auth.organizationId)
      const settings=db.prepare(`SELECT auto_advance autoAdvance,fill_groups fillGroups,target_groups targetGroups,auto_publish autoPublish
        FROM organization_settings WHERE organization_id=?`).get(auth.organizationId) as Record<string,unknown>|undefined
      let targetGroups:string[]=[]
      try { const parsed=JSON.parse(String(settings?.targetGroups||'[]')); if(Array.isArray(parsed))targetGroups=parsed.map(String) } catch { /* lista antiga inválida */ }
      const configuredGroups=marketplaceGroups(auth.organizationId,true)
      if(configuredGroups.length)targetGroups=configuredGroups.map(groupTarget)
      const leaseToken=randomBytes(24).toString('hex'),leaseSeconds=120
      const acquired=db.prepare(`UPDATE publication_jobs SET status='filling',attempt_count=attempt_count+1,error_code=NULL,started_at=CURRENT_TIMESTAMP,
        lease_token=?,lease_owner=?,lease_expires_at=datetime('now',?),updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?
        AND social_account_id=? AND paused=0 AND status IN ('pending','filling','error','awaiting_confirmation')
        AND (scheduled_at IS NULL OR datetime(scheduled_at)<=CURRENT_TIMESTAMP)
        AND (lease_expires_at IS NULL OR datetime(lease_expires_at)<=CURRENT_TIMESTAMP)`).run(leaseToken,instanceId,`+${leaseSeconds} seconds`,job.id,auth.organizationId,accountId)
      if(!acquired.changes)return send(res,409,{error:'Este trabalho acabou de ser aberto por outra aba ou instância.'})
      recordJobEvent(auth.organizationId,job.id,'filling_started',null,{accountId,instanceId})
      return send(res,200,{jobId:job.id,accountId,leaseToken,leaseSeconds,vehicle:{...vehicle,images},automation:{autoAdvance:Boolean(settings?.autoAdvance),fillGroups:Boolean(settings?.fillGroups),targetGroups,autoPublish:Boolean(settings?.autoPublish)}})
    }
    const extensionHeartbeat=url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/heartbeat$/)
    if(req.method==='POST'&&extensionHeartbeat){
      const b=await jsonBody(req) as Record<string,unknown>,leaseToken=String(b.leaseToken||'')
      const updated=db.prepare(`UPDATE publication_jobs SET lease_expires_at=datetime('now','+120 seconds'),updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND organization_id=? AND status='filling' AND lease_token=? AND datetime(lease_expires_at)>CURRENT_TIMESTAMP`).run(Number(extensionHeartbeat[1]),auth.organizationId,leaseToken)
      if(!updated.changes)return send(res,409,{error:'O bloqueio desta execução expirou ou pertence a outra instância.'})
      return send(res,200,{ok:true,leaseSeconds:120})
    }
    const extensionFillResult = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/fill-result$/)
    if (req.method === 'PATCH' && extensionFillResult) {
      const b=await jsonBody(req) as Record<string,unknown>
      const job = db.prepare(`SELECT j.id,j.status,j.social_account_id accountId,j.lease_token leaseToken,j.lease_expires_at leaseExpiresAt FROM publication_jobs j
        WHERE j.id=? AND j.organization_id=?`).get(Number(extensionFillResult[1]),auth.organizationId) as {id:number;status:string;accountId:number;leaseToken?:string;leaseExpiresAt?:string}|undefined
      if (!job || !allowedExtensionAccount(job.accountId,auth)) return send(res,404,{error:'Trabalho não encontrado para este perfil.'})
      if(job.status!=='filling'||!job.leaseToken||String(b.leaseToken||'')!==job.leaseToken||!job.leaseExpiresAt||Date.parse(job.leaseExpiresAt.replace(' ','T')+'Z')<=Date.now())return send(res,409,{error:'A execução perdeu o bloqueio exclusivo. Reabra o trabalho pela extensão.'})
      const error=String(b.error||'').slice(0,240)
      if (error) {
        db.prepare(`UPDATE publication_jobs SET status='error',error_code=?,extension_version=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
          .run(error,String(b.extensionVersion||'').slice(0,30),job.id,auth.organizationId)
        recordJobEvent(auth.organizationId,job.id,'fill_error',null,{error,extensionVersion:String(b.extensionVersion||'').slice(0,30)})
        return send(res,200,{ok:true,status:'error'})
      }
      const report={
        filledCount:Math.max(0,Number(b.filledCount)||0),totalCount:Math.max(0,Number(b.totalCount)||0),
        imageCount:Math.max(0,Number(b.imageCount)||0),missing:Array.isArray(b.missing)?b.missing.map(String).slice(0,30):[],
        fields:Array.isArray(b.fields)?b.fields.slice(0,30):[],advanced:Boolean(b.advanced),
        selectedGroups:Array.isArray(b.selectedGroups)?b.selectedGroups.map(String).slice(0,20):[],
        missingGroups:Array.isArray(b.missingGroups)?b.missingGroups.map(String).slice(0,20):[],
        flowIssues:Array.isArray(b.flowIssues)?b.flowIssues.map(value=>String(value).slice(0,240)).slice(0,10):[],published:Boolean(b.published),publishAttempted:Boolean(b.publishAttempted)
      }
      const registeredGroups=marketplaceGroups(auth.organizationId)
      for(const target of report.selectedGroups){
        const parsed=parseGroupTarget(target),group=registeredGroups.find(item=>(parsed.groupKey&&item.groupKey===parsed.groupKey)||item.name.toLocaleLowerCase('pt-BR')===parsed.name.toLocaleLowerCase('pt-BR'))
        if(group)db.prepare('UPDATE marketplace_groups SET success_count=success_count+1,last_found_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(group.id,auth.organizationId)
      }
      for(const target of report.missingGroups){
        const parsed=parseGroupTarget(target),group=registeredGroups.find(item=>(parsed.groupKey&&item.groupKey===parsed.groupKey)||item.name.toLocaleLowerCase('pt-BR')===parsed.name.toLocaleLowerCase('pt-BR'))
        if(group)db.prepare('UPDATE marketplace_groups SET failure_count=failure_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(group.id,auth.organizationId)
      }
      if(report.published){
        const vehicleId=(db.prepare('SELECT vehicle_id vehicleId FROM publication_jobs WHERE id=? AND organization_id=?').get(job.id,auth.organizationId) as {vehicleId:number}).vehicleId
        db.exec('BEGIN')
        try{
          db.prepare(`UPDATE publication_jobs SET status='completed',fill_report=?,extension_version=?,result_url=?,error_code=NULL,filled_at=CURRENT_TIMESTAMP,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
            .run(JSON.stringify(report),String(b.extensionVersion||'').slice(0,30),String(b.resultUrl||'').slice(0,500),job.id,auth.organizationId)
          db.prepare("UPDATE vehicles SET status='Publicado',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(vehicleId,auth.organizationId)
          recordJobEvent(auth.organizationId,job.id,'auto_published',null,{resultUrl:String(b.resultUrl||'').slice(0,500),selectedGroups:report.selectedGroups.length,extensionVersion:String(b.extensionVersion||'').slice(0,30)})
          db.exec('COMMIT')
        }catch(error){db.exec('ROLLBACK');throw error}
        return send(res,200,{ok:true,status:'completed'})
      }
      db.prepare(`UPDATE publication_jobs SET status='awaiting_confirmation',fill_report=?,extension_version=?,error_code=NULL,filled_at=CURRENT_TIMESTAMP,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
        .run(JSON.stringify(report),String(b.extensionVersion||'').slice(0,30),job.id,auth.organizationId)
      recordJobEvent(auth.organizationId,job.id,'filled_waiting_confirmation',null,{filledCount:report.filledCount,totalCount:report.totalCount,imageCount:report.imageCount,advanced:report.advanced,publishAttempted:report.publishAttempted,missing:report.missing,missingGroups:report.missingGroups,flowIssues:report.flowIssues,extensionVersion:String(b.extensionVersion||'').slice(0,30)})
      return send(res,200,{ok:true,status:'awaiting_confirmation'})
    }
    if (req.method === 'POST' && url.pathname === '/api/vehicles') {
      const b = await jsonBody(req) as Record<string,unknown>
      const validationError=validateVehicleBody(b)
      if (validationError) return send(res,400,{error:validationError})
      const result = db.prepare(`INSERT INTO vehicles (organization_id,year,make,model,trim,price,km,status,assigned_user_id,vehicle_type,location,transmission,fuel_type,body_type,exterior_color,interior_color,vehicle_condition,description)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(auth.organizationId,Number(b.year),String(b.make),String(b.model).trim(),String(b.trim||''),Number(b.price),Number(b.km),String(b.status||'Rascunho'),auth.userId,String(b.vehicleType),String(b.location).trim(),String(b.transmission),String(b.fuelType),String(b.bodyType),String(b.exteriorColor),String(b.interiorColor),String(b.condition),String(b.description).trim())
      return send(res,201,{id:Number(result.lastInsertRowid)})
    }
    const vehicleRoute = url.pathname.match(/^\/api\/vehicles\/(\d+)$/)
    if (req.method === 'PATCH' && vehicleRoute) {
      const b = await jsonBody(req) as Record<string,unknown>
      const validationError=validateVehicleBody(b)
      if (validationError) return send(res,400,{error:validationError})
      const result = db.prepare(`UPDATE vehicles SET year=?,make=?,model=?,trim=?,price=?,km=?,vehicle_type=?,location=?,transmission=?,fuel_type=?,body_type=?,exterior_color=?,interior_color=?,vehicle_condition=?,description=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
        .run(Number(b.year),String(b.make),String(b.model).trim(),String(b.trim||''),Number(b.price),Number(b.km),String(b.vehicleType),String(b.location).trim(),String(b.transmission),String(b.fuelType),String(b.bodyType),String(b.exteriorColor),String(b.interiorColor),String(b.condition),String(b.description).trim(),String(b.status||'Rascunho'),Number(vehicleRoute[1]),auth.organizationId)
      return result.changes?send(res,200,{ok:true}):send(res,404,{error:'Veículo não encontrado.'})
    }
    const markSoldRoute = url.pathname.match(/^\/api\/vehicles\/(\d+)\/mark-sold$/)
    if (req.method === 'POST' && markSoldRoute) {
      const result = db.prepare("UPDATE vehicles SET status='Vendido',sold_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?")
        .run(Number(markSoldRoute[1]),auth.organizationId)
      return result.changes?send(res,200,{ok:true}):send(res,404,{error:'Veículo não encontrado.'})
    }
    const vehicleImagesRoute = url.pathname.match(/^\/api\/vehicles\/(\d+)\/images$/)
    if (req.method === 'GET' && vehicleImagesRoute) {
      const images = db.prepare(`SELECT id,original_name originalName,mime_type mimeType,position,'http://127.0.0.1:3333/uploads/'||file_name url FROM vehicle_images WHERE vehicle_id=? AND organization_id=? ORDER BY position,id`).all(Number(vehicleImagesRoute[1]),auth.organizationId)
      return send(res,200,{images})
    }
    if (req.method === 'POST' && vehicleImagesRoute) {
      const b = await jsonBody(req) as Record<string,unknown>
      const vehicleId = Number(vehicleImagesRoute[1])
      if (!db.prepare('SELECT id FROM vehicles WHERE id=? AND organization_id=?').get(vehicleId,auth.organizationId)) return send(res,404,{error:'Veículo não encontrado.'})
      const mime = String(b.mimeType||'')
      if (!['image/jpeg','image/png','image/webp'].includes(mime)) return send(res,400,{error:'Use imagens JPG, PNG ou WebP.'})
      const bytes = Buffer.from(String(b.dataBase64||''),'base64')
      if (!bytes.length || bytes.length>12*1024*1024) return send(res,400,{error:'A imagem deve ter no máximo 12 MB.'})
      const ext = mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg'
      const fileName = `${randomBytes(12).toString('hex')}.${ext}`
      const contentHash=createHash('sha256').update(bytes).digest('hex')
      writeFileSync(join(uploadsDir,fileName),bytes)
      const position = (db.prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM vehicle_images WHERE vehicle_id=?').get(vehicleId) as {next:number}).next
      const result = db.prepare('INSERT INTO vehicle_images (organization_id,vehicle_id,file_name,original_name,mime_type,position,content_hash) VALUES (?,?,?,?,?,?,?)').run(auth.organizationId,vehicleId,fileName,String(b.name||fileName),mime,position,contentHash)
      return send(res,201,{id:Number(result.lastInsertRowid),url:`http://127.0.0.1:3333/uploads/${fileName}`})
    }
    const imageReorderRoute = url.pathname.match(/^\/api\/vehicles\/(\d+)\/images\/reorder$/)
    if (req.method === 'PATCH' && imageReorderRoute) {
      const vehicleId = Number(imageReorderRoute[1])
      if (!db.prepare('SELECT id FROM vehicles WHERE id=? AND organization_id=?').get(vehicleId,auth.organizationId)) return send(res,404,{error:'Veículo não encontrado.'})
      const b = await jsonBody(req) as {order?:unknown[]}
      const order = Array.isArray(b.order) ? b.order.map(Number).filter(Number.isInteger) : []
      const owned = db.prepare('SELECT id FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').all(vehicleId,auth.organizationId) as Array<{id:number}>
      const ownedIds = new Set(owned.map(item=>item.id))
      if (order.length !== owned.length || new Set(order).size !== order.length || !order.every(id=>ownedIds.has(id))) return send(res,400,{error:'Lista de fotos inválida.'})
      db.exec('BEGIN')
      try {
        order.forEach((id,index)=>{ db.prepare('UPDATE vehicle_images SET position=? WHERE id=? AND vehicle_id=? AND organization_id=?').run(index,id,vehicleId,auth.organizationId) })
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      return send(res,200,{ok:true})
    }
    const imageRoute = url.pathname.match(/^\/api\/vehicle-images\/(\d+)$/)
    if (req.method === 'DELETE' && imageRoute) {
      const image = db.prepare('SELECT file_name fileName FROM vehicle_images WHERE id=? AND organization_id=?').get(Number(imageRoute[1]),auth.organizationId) as {fileName:string}|undefined
      if (!image) return send(res,404,{error:'Imagem não encontrada.'})
      const path = join(uploadsDir,image.fileName); if (existsSync(path)) unlinkSync(path)
      db.prepare('DELETE FROM vehicle_images WHERE id=? AND organization_id=?').run(Number(imageRoute[1]),auth.organizationId)
      return send(res,200,{ok:true})
    }
    if (req.method === 'DELETE' && url.pathname === '/api/vehicles') {
      const b = await jsonBody(req) as {ids?:unknown[]}
      const ids = [...new Set((b.ids||[]).map(Number).filter(Number.isInteger))].slice(0,100)
      if (!ids.length) return send(res,400,{error:'Selecione pelo menos um veículo.'})
      const owned = db.prepare(`SELECT id FROM vehicles WHERE organization_id=? AND id IN (${ids.map(()=>'?').join(',')})`).all(auth.organizationId,...ids) as Array<{id:number}>
      if(!owned.length)return send(res,404,{error:'Nenhum dos veículos selecionados foi encontrado.'})
      const filesToDelete:string[]=[]
      let removedJobs=0
      db.exec('BEGIN')
      try {
        for (const item of owned) {
          const images = db.prepare('SELECT file_name fileName FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').all(item.id,auth.organizationId) as Array<{fileName:string}>
          filesToDelete.push(...images.map(image=>join(uploadsDir,image.fileName)))
          const jobIds=db.prepare('SELECT id FROM publication_jobs WHERE vehicle_id=? AND organization_id=?').all(item.id,auth.organizationId) as Array<{id:number}>
          if(jobIds.length){
            const placeholders=jobIds.map(()=>'?').join(',')
            db.prepare(`DELETE FROM publication_job_events WHERE organization_id=? AND publication_job_id IN (${placeholders})`).run(auth.organizationId,...jobIds.map(job=>job.id))
          }
          removedJobs+=Number(db.prepare('DELETE FROM publication_jobs WHERE vehicle_id=? AND organization_id=?').run(item.id,auth.organizationId).changes)
          db.prepare('DELETE FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').run(item.id,auth.organizationId)
          db.prepare('DELETE FROM vehicles WHERE id=? AND organization_id=?').run(item.id,auth.organizationId)
        }
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      for(const path of filesToDelete)try{if(existsSync(path))unlinkSync(path)}catch(error){console.warn(`Não foi possível remover o arquivo órfão ${path}:`,error)}
      return send(res,200,{deleted:owned.length,removedJobs})
    }
    if (req.method === 'GET' && url.pathname === '/api/team') {
      const current=userById(auth.userId) as {role?:string}|undefined
      const users = db.prepare('SELECT id,name,email,role FROM users WHERE organization_id=? ORDER BY name').all(auth.organizationId)
      const accounts = db.prepare(`SELECT a.id,a.user_id userId,a.label,a.platform,a.status,a.browser_profile browserProfile,a.last_seen_at lastSeenAt,u.name owner
        FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.organization_id=? ORDER BY u.name,a.label`).all(auth.organizationId)
      return send(res,200,{users,accounts,canManageQueue:current?.role==='admin'})
    }
    if (req.method === 'GET' && url.pathname === '/api/overview') {
      const vehicleStats = db.prepare(`SELECT COUNT(*) total,
        SUM(CASE WHEN status='Publicado' THEN 1 ELSE 0 END) published,
        SUM(CASE WHEN status='Pronto' THEN 1 ELSE 0 END) ready,
        SUM(CASE WHEN status='Atenção' THEN 1 ELSE 0 END) attention,
        COALESCE(SUM(price),0) inventoryValue FROM vehicles WHERE organization_id=?`).get(auth.organizationId)
      const jobStats = db.prepare(`SELECT COUNT(*) jobs,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors FROM publication_jobs WHERE organization_id=?`).get(auth.organizationId)
      return send(res,200,{vehicleStats,jobStats})
    }
    if (req.method === 'GET' && url.pathname === '/api/automation/overview') {
      const current=userById(auth.userId) as {role?:string}|undefined
      const accounts=(current?.role==='admin'
        ?db.prepare(`SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.last_seen_at lastSeenAt,u.name owner
          FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.organization_id=? ORDER BY u.name,a.label`).all(auth.organizationId)
        :db.prepare(`SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.last_seen_at lastSeenAt,u.name owner
          FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.organization_id=? AND a.user_id=? ORDER BY a.label`).all(auth.organizationId,auth.userId)) as Array<{id:number;label:string;browserProfile?:string;status:string;lastSeenAt?:string;owner:string}>
      const settings=db.prepare('SELECT daily_limit dailyLimit,stuck_timeout_minutes stuckTimeoutMinutes FROM organization_settings WHERE organization_id=?').get(auth.organizationId) as {dailyLimit?:number;stuckTimeoutMinutes?:number}|undefined
      const profiles=accounts.map(account=>{
        const latest=db.prepare(`SELECT j.id,j.status,j.paused,j.scheduled_at scheduledAt,j.attempt_count attemptCount,j.fill_report fillReport,j.extension_version extensionVersion,
          j.started_at startedAt,j.updated_at updatedAt,j.lease_expires_at leaseExpiresAt,v.year,v.make,v.model
          FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id WHERE j.organization_id=? AND j.social_account_id=?
          ORDER BY CASE WHEN j.status IN ('filling','pending','awaiting_confirmation','error') AND j.paused=0 AND (j.scheduled_at IS NULL OR datetime(j.scheduled_at)<=CURRENT_TIMESTAMP) THEN 0 WHEN j.status IN ('filling','pending','awaiting_confirmation','error') AND j.paused=0 THEN 1 WHEN j.status IN ('filling','pending','awaiting_confirmation','error') THEN 2 ELSE 3 END,j.queue_priority,j.updated_at DESC LIMIT 1`).get(auth.organizationId,account.id) as {id:number;status:string;paused:number;scheduledAt?:string;attemptCount?:number;fillReport?:string;extensionVersion?:string;startedAt?:string;updatedAt?:string;leaseExpiresAt?:string;year:number;make:string;model:string}|undefined
        const today=(db.prepare("SELECT COUNT(*) total FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND date(created_at)=date('now') AND status!='canceled'").get(auth.organizationId,account.id) as {total:number}).total
        const successes=(db.prepare("SELECT COUNT(*) total FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND status IN ('completed','removed')").get(auth.organizationId,account.id) as {total:number}).total
        const failures=(db.prepare("SELECT COUNT(*) total FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND status='error'").get(auth.organizationId,account.id) as {total:number}).total
        let report:{advanced?:boolean;publishAttempted?:boolean;missing?:string[];missingGroups?:string[];flowIssues?:string[]}|null=null
        try{report=latest?.fillReport?JSON.parse(latest.fillReport):null}catch{/* relatório antigo inválido */}
        const scheduled=latest?.scheduledAt&&Date.parse(latest.scheduledAt)>Date.now()
        let stage=!latest?'Sem atividade':latest.paused?'Pausado pelo painel':scheduled?'Aguardando horário agendado':latest.status==='pending'?'Na fila':latest.status==='filling'?'Preenchendo dados':latest.status==='error'?'Erro — requer revisão':latest.status==='awaiting_confirmation'?(report?.advanced?'Etapa final / revisão':'Dados preenchidos'):latest.status==='completed'?'Publicado':latest.status==='removed'?'Anúncio removido':'Encerrado'
        const lastSeenTime=account.lastSeenAt?Date.parse(String(account.lastSeenAt).replace(' ','T')+'Z'):0
        const online=account.status==='connected'&&lastSeenTime>Date.now()-5*60*1000
        const startedTime=latest?.startedAt?Date.parse(String(latest.startedAt).replace(' ','T')+'Z'):0
        const durationSeconds=startedTime?Math.max(0,Math.round((Date.now()-startedTime)/1000)):0
        const leaseTime=latest?.leaseExpiresAt?Date.parse(String(latest.leaseExpiresAt).replace(' ','T')+'Z'):0
        const leaseActive=latest?.status==='filling'&&leaseTime>Date.now()
        const stalled=latest?.status==='filling'&&!leaseActive&&durationSeconds>=Number(settings?.stuckTimeoutMinutes||15)*60
        if(stalled)stage=`Preenchimento travado há ${Math.max(1,Math.floor(durationSeconds/60))} min`
        return {...account,online,today,dailyLimit:Number(settings?.dailyLimit||10),successes,failures,stage,
          currentJob:latest?{id:latest.id,status:latest.status,paused:Boolean(latest.paused),scheduledAt:latest.scheduledAt,attemptCount:latest.attemptCount||0,extensionVersion:latest.extensionVersion||'',startedAt:latest.startedAt,updatedAt:latest.updatedAt,leaseActive,leaseExpiresAt:latest.leaseExpiresAt,publishAttempted:Boolean(report?.publishAttempted),year:latest.year,make:latest.make,model:latest.model,durationSeconds,stalled,stuckTimeoutMinutes:Number(settings?.stuckTimeoutMinutes||15),issues:[...(report?.missing||[]),...(report?.missingGroups||[]),...(report?.flowIssues||[])]}:null}
      })
      return send(res,200,{profiles,serverNow:new Date().toISOString(),onlineWindowSeconds:300})
    }
    if (req.method === 'GET' && url.pathname === '/api/publications') {
      const rows = db.prepare(`SELECT j.id,j.status,j.result_url resultUrl,j.error_code errorCode,j.fill_report fillReport,
        j.extension_version extensionVersion,j.extension_visible extensionVisible,j.queue_priority queuePriority,j.paused,j.scheduled_at scheduledAt,j.started_at startedAt,j.filled_at filledAt,j.removed_at removedAt,j.created_at createdAt,j.updated_at updatedAt,
        v.id vehicleId,v.year,v.make,v.model,v.price,j.social_account_id accountId,COALESCE(a.label,'Perfil não definido') accountLabel,
        (SELECT previous.label FROM publication_job_events event LEFT JOIN social_accounts previous ON previous.id=event.from_account_id
          WHERE event.publication_job_id=j.id AND event.event_type='reassigned' ORDER BY event.created_at DESC,event.id DESC LIMIT 1) previousAccountLabel,
        (SELECT event.created_at FROM publication_job_events event WHERE event.publication_job_id=j.id AND event.event_type='reassigned' ORDER BY event.created_at DESC,event.id DESC LIMIT 1) reassignedAt,
        COALESCE(u.name,'Não atribuído') seller FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id
        LEFT JOIN social_accounts a ON a.id=j.social_account_id LEFT JOIN users u ON u.id=v.assigned_user_id
        WHERE j.organization_id=? ORDER BY CASE WHEN j.status IN ('pending','filling','error','awaiting_confirmation') THEN 0 ELSE 1 END,j.paused,j.queue_priority,j.created_at DESC`).all(auth.organizationId)
      const jobs=(rows as Array<Record<string,unknown>>).map(item=>{try{return{...item,fillReport:item.fillReport?JSON.parse(String(item.fillReport)):null}}catch{return{...item,fillReport:null}}})
      return send(res,200,{jobs})
    }
    if(req.method==='GET'&&url.pathname==='/api/reports/issues'){
      const rows=db.prepare(`SELECT event.id eventId,event.event_type eventType,event.details,event.created_at occurredAt,
        j.id jobId,j.status jobStatus,j.extension_version extensionVersion,v.year,v.make,v.model,
        COALESCE(a.label,'Perfil não definido') accountLabel,COALESCE(u.name,'Não atribuído') seller,
        (SELECT MAX(latest.id) FROM publication_job_events latest WHERE latest.publication_job_id=j.id
          AND latest.event_type IN ('fill_error','filled_waiting_confirmation','stalled_recovered','duplicate_blocked')) latestIssueEventId
        FROM publication_job_events event JOIN publication_jobs j ON j.id=event.publication_job_id
        JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN social_accounts a ON a.id=j.social_account_id
        LEFT JOIN users u ON u.id=v.assigned_user_id WHERE event.organization_id=?
        AND event.event_type IN ('fill_error','filled_waiting_confirmation','stalled_recovered','duplicate_blocked')
        ORDER BY datetime(event.created_at) DESC,event.id DESC`).all(auth.organizationId) as Array<{eventId:number;eventType:string;details:string;occurredAt:string;jobId:number;jobStatus:string;extensionVersion?:string;year:number;make:string;model:string;accountLabel:string;seller:string;latestIssueEventId?:number}>
      const issues:Array<Record<string,unknown>>=[]
      for(const row of rows){
        let details:Record<string,unknown>={}
        try{details=JSON.parse(String(row.details||'{}'))}catch{/* evento antigo sem JSON válido */}
        const base={eventId:row.eventId,jobId:row.jobId,jobStatus:row.jobStatus,extensionVersion:String(details.extensionVersion||row.extensionVersion||''),year:row.year,make:row.make,model:row.model,accountLabel:row.accountLabel,seller:row.seller,occurredAt:row.occurredAt}
        const active=Number(row.eventId)===Number(row.latestIssueEventId)&&((row.eventType==='fill_error'&&row.jobStatus==='error')||(row.eventType==='filled_waiting_confirmation'&&row.jobStatus==='awaiting_confirmation')||(row.eventType==='duplicate_blocked'&&['pending','awaiting_confirmation'].includes(row.jobStatus)))
        const add=(severity:'error'|'warning',category:string,message:string)=>issues.push({...base,severity,category,message:String(message).slice(0,300),active})
        if(row.eventType==='fill_error')add('error','execution',String(details.error||'Falha durante o preenchimento no Facebook.'))
        if(row.eventType==='filled_waiting_confirmation'){
          for(const field of Array.isArray(details.missing)?details.missing:[])add('warning','fields',`Campo não confirmado: ${field}`)
          for(const group of Array.isArray(details.missingGroups)?details.missingGroups:[])add('warning','groups',`Grupo não encontrado: ${group}`)
          for(const issue of Array.isArray(details.flowIssues)?details.flowIssues:[])add('warning','flow',issue)
        }
        if(row.eventType==='stalled_recovered')add('warning','recovery',`Execução travada recuperada${Number(details.elapsedMinutes)>0?` após ${details.elapsedMinutes} min`:''}.`)
        if(row.eventType==='duplicate_blocked')add('warning','duplicate',String(details.message||'Possível anúncio duplicado bloqueado antes do envio ao Facebook.'))
      }
      return send(res,200,{issues,generatedAt:new Date().toISOString(),definitions:{errors:'Falhas que interromperam uma tentativa de preenchimento.',warnings:'Campos, grupos, etapas ou recuperações que exigiram atenção.'}})
    }
    const publicationTimeline=url.pathname.match(/^\/api\/publications\/(\d+)\/timeline$/)
    if(req.method==='GET'&&publicationTimeline){
      const job=db.prepare(`SELECT j.id,j.created_at createdAt,v.year,v.make,v.model,COALESCE(a.label,'Perfil não definido') accountLabel
        FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id LEFT JOIN social_accounts a ON a.id=j.social_account_id
        WHERE j.id=? AND j.organization_id=?`).get(Number(publicationTimeline[1]),auth.organizationId) as {id:number;createdAt:string;year:number;make:string;model:string;accountLabel:string}|undefined
      if(!job)return send(res,404,{error:'Publicação não encontrada.'})
      const rows=db.prepare(`SELECT event.id,event.event_type eventType,event.details,event.created_at createdAt,
        COALESCE(user.name,'Extensão AutoFlow') actor,previous.label fromAccount,next.label toAccount
        FROM publication_job_events event LEFT JOIN users user ON user.id=event.created_by
        LEFT JOIN social_accounts previous ON previous.id=event.from_account_id LEFT JOIN social_accounts next ON next.id=event.to_account_id
        WHERE event.organization_id=? AND event.publication_job_id=? ORDER BY datetime(event.created_at) DESC,event.id DESC`).all(auth.organizationId,job.id) as Array<{id:number;eventType:string;details:string;createdAt:string;actor:string;fromAccount:string|null;toAccount:string|null}>
      const events=rows.map(row=>{let details:Record<string,unknown>={};try{details=JSON.parse(String(row.details||'{}'))}catch{/* evento antigo sem JSON válido */}return{...row,details}})
      if(!events.some(event=>event.eventType==='created'))events.push({id:0,eventType:'created',details:{accountLabel:job.accountLabel},createdAt:job.createdAt,actor:'Sistema',fromAccount:null,toAccount:null})
      events.sort((a,b)=>Date.parse(String(b.createdAt))-Date.parse(String(a.createdAt))||Number(b.id)-Number(a.id))
      return send(res,200,{job,events})
    }
    const recoverPublication=url.pathname.match(/^\/api\/publications\/(\d+)\/recover$/)
    if(req.method==='POST'&&recoverPublication){
      const currentUser=userById(auth.userId) as {role?:string}|undefined
      if(currentUser?.role!=='admin')return send(res,403,{error:'Somente administradores podem recuperar trabalhos em preenchimento.'})
      const job=db.prepare(`SELECT id,status,started_at startedAt,lease_expires_at leaseExpiresAt FROM publication_jobs WHERE id=? AND organization_id=?`).get(Number(recoverPublication[1]),auth.organizationId) as {id:number;status:string;startedAt?:string;leaseExpiresAt?:string}|undefined
      if(!job)return send(res,404,{error:'Trabalho não encontrado.'})
      if(job.status!=='filling')return send(res,409,{error:'Somente trabalhos em preenchimento podem ser recuperados.'})
      const elapsedMinutes=job.startedAt?Math.max(0,Math.floor((Date.now()-Date.parse(job.startedAt.replace(' ','T')+'Z'))/60000)):0
      const timeout=(db.prepare('SELECT stuck_timeout_minutes value FROM organization_settings WHERE organization_id=?').get(auth.organizationId) as {value?:number}|undefined)?.value||15
      if(elapsedMinutes<timeout)return send(res,409,{error:`Este trabalho ainda está dentro do tempo normal de preenchimento (${timeout} min).`})
      const leaseExpiresAt=job.leaseExpiresAt?Date.parse(job.leaseExpiresAt.replace(' ','T')+'Z'):0
      if(leaseExpiresAt>Date.now())return send(res,409,{error:'A extensao ainda esta trabalhando neste item. Aguarde o fim do bloqueio exclusivo.'})
      db.exec('BEGIN')
      try{
        db.prepare("UPDATE publication_jobs SET status='pending',paused=0,extension_visible=1,error_code=NULL,fill_report='',started_at=NULL,filled_at=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(job.id,auth.organizationId)
        recordJobEvent(auth.organizationId,job.id,'stalled_recovered',auth.userId,{elapsedMinutes})
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(res,200,{ok:true,status:'pending'})
    }
    if (req.method === 'POST' && url.pathname === '/api/publications') {
      const b = await jsonBody(req) as Record<string,unknown>
      const vehicle = db.prepare(`SELECT id,year,make,model,price,km,location,description,vehicle_type vehicleType,
        transmission,fuel_type fuelType,body_type bodyType,exterior_color exteriorColor,interior_color interiorColor,vehicle_condition condition
        FROM vehicles WHERE id=? AND organization_id=?`).get(Number(b.vehicleId),auth.organizationId) as {id:number;year:number;make:string;model:string;price:number;km:number;location:string;description:string;vehicleType:string;transmission:string;fuelType:string;bodyType:string;exteriorColor:string;interiorColor:string;condition:string}|undefined
      if (!vehicle) return send(res,400,{error:'Veículo inválido.'})
      const imageCount = (db.prepare('SELECT COUNT(*) c FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').get(vehicle.id,auth.organizationId) as {c:number}).c
      const missing:string[] = []
      if (!(vehicle.price>0)) missing.push('Preço')
      if (!(vehicle.year>=1900)) missing.push('Ano')
      if (!String(vehicle.make||'').trim()) missing.push('Fabricante')
      if (!String(vehicle.model||'').trim()) missing.push('Modelo')
      if (!(vehicle.km>=0)) missing.push('Quilometragem')
      if (!vehicle.location.trim()) missing.push('Localização')
      if (!vehicleOptions.vehicleType.has(String(vehicle.vehicleType))) missing.push('Tipo de veículo')
      if (!vehicleOptions.transmission.has(String(vehicle.transmission))) missing.push('Câmbio')
      if (!vehicleOptions.fuelType.has(String(vehicle.fuelType))) missing.push('Combustível')
      if (!vehicleOptions.bodyType.has(String(vehicle.bodyType))) missing.push('Carroceria')
      if (!vehicleOptions.condition.has(String(vehicle.condition))) missing.push('Condição do veículo')
      if (!vehicleOptions.color.has(String(vehicle.exteriorColor))) missing.push('Cor externa')
      if (!vehicleOptions.color.has(String(vehicle.interiorColor))) missing.push('Cor interna')
      if (!vehicle.description.trim()) missing.push('Descrição')
      if (!imageCount) missing.push('Fotos')
      if (missing.length) {
        db.prepare("UPDATE vehicles SET status='Atenção',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(vehicle.id,auth.organizationId)
        return send(res,422,{error:'Complete os dados obrigatórios antes de publicar.',missing})
      }
      const accountId=Number(b.accountId)
      if (!Number.isInteger(accountId)||!db.prepare('SELECT id FROM social_accounts WHERE id=? AND organization_id=?').get(accountId,auth.organizationId)) return send(res,400,{error:'Selecione o perfil do Brave que publicará este veículo.'})
      const duplicateRisk=publicationDuplicateRisk(auth.organizationId,vehicle.id)
      if(duplicateRisk)return send(res,409,{error:duplicateRisk.message,duplicate:duplicateRisk})
      const settings=db.prepare('SELECT daily_limit dailyLimit FROM organization_settings WHERE organization_id=?').get(auth.organizationId) as {dailyLimit:number}|undefined
      const today=(db.prepare("SELECT COUNT(*) total FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND date(created_at)=date('now') AND status!='canceled'").get(auth.organizationId,accountId) as {total:number}).total
      if(today>=Number(settings?.dailyLimit||10))return send(res,429,{error:`O perfil atingiu o limite diário de ${settings?.dailyLimit||10} trabalhos.`})
      const nextPriority=((db.prepare(`SELECT COALESCE(MAX(queue_priority),0)+1 value FROM publication_jobs
        WHERE organization_id=? AND social_account_id=? AND status IN ('pending','filling','error','awaiting_confirmation')`).get(auth.organizationId,accountId) as {value:number}).value)||1
      let scheduledAt:string|null=null
      if(String(b.scheduledAt||'').trim()){
        const timestamp=Date.parse(String(b.scheduledAt))
        if(!Number.isFinite(timestamp)||timestamp<Date.now()-60000)return send(res,400,{error:'Selecione uma data e hora futura para o agendamento.'})
        scheduledAt=new Date(timestamp).toISOString()
      }
      const result = db.prepare('INSERT INTO publication_jobs (organization_id,vehicle_id,social_account_id,status,queue_priority,scheduled_at) VALUES (?,?,?,?,?,?)').run(auth.organizationId,Number(b.vehicleId),accountId,'pending',nextPriority,scheduledAt)
      recordJobEvent(auth.organizationId,Number(result.lastInsertRowid),'created',auth.userId,{accountId,scheduledAt,queuePriority:nextPriority})
      db.prepare("UPDATE vehicles SET status='Pronto',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(Number(b.vehicleId),auth.organizationId)
      return send(res,201,{id:Number(result.lastInsertRowid)})
    }
    if (req.method === 'PATCH' && url.pathname === '/api/publications/extension-visibility') {
      const b=await jsonBody(req) as Record<string,unknown>
      const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(Number).filter(Number.isInteger))]:[]
      if(!ids.length)return send(res,400,{error:'Selecione pelo menos um trabalho.'})
      const placeholders=ids.map(()=>'?').join(',')
      const owned=db.prepare(`SELECT id FROM publication_jobs WHERE organization_id=? AND id IN (${placeholders})`).all(auth.organizationId,...ids) as Array<{id:number}>
      if(owned.length!==ids.length)return send(res,400,{error:'Um ou mais trabalhos não pertencem a esta empresa.'})
      const visible=b.visible===true?1:0
      db.prepare(`UPDATE publication_jobs SET extension_visible=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id IN (${placeholders})`).run(visible,auth.organizationId,...ids)
      for(const id of ids)recordJobEvent(auth.organizationId,id,visible?'shown_in_extension':'hidden_from_extension',auth.userId)
      return send(res,200,{updated:ids.length,visible:Boolean(visible)})
    }
    if (req.method === 'PATCH' && url.pathname === '/api/publications/queue-state') {
      const b=await jsonBody(req) as Record<string,unknown>
      const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(Number).filter(Number.isInteger))]:[]
      if(!ids.length)return send(res,400,{error:'Selecione pelo menos um trabalho.'})
      if(!['pause','resume'].includes(String(b.action)))return send(res,400,{error:'Ação de fila inválida.'})
      const placeholders=ids.map(()=>'?').join(',')
      const owned=db.prepare(`SELECT id,status FROM publication_jobs WHERE organization_id=? AND id IN (${placeholders})`).all(auth.organizationId,...ids) as Array<{id:number;status:string}>
      if(owned.length!==ids.length)return send(res,400,{error:'Um ou mais trabalhos não pertencem a esta empresa.'})
      if(owned.some(job=>!['pending','error','awaiting_confirmation'].includes(job.status)))return send(res,409,{error:'Trabalhos em preenchimento ou encerrados não podem ser pausados.'})
      const paused=String(b.action)==='pause'?1:0
      if(paused)db.prepare(`UPDATE publication_jobs SET paused=1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id IN (${placeholders})`).run(auth.organizationId,...ids)
      else db.prepare(`UPDATE publication_jobs SET paused=0,extension_visible=1,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND id IN (${placeholders})`).run(auth.organizationId,...ids)
      for(const id of ids)recordJobEvent(auth.organizationId,id,paused?'paused':'resumed',auth.userId)
      return send(res,200,{updated:ids.length,paused:Boolean(paused)})
    }
    if (req.method === 'PATCH' && url.pathname === '/api/publications/reassign') {
      const currentUser=userById(auth.userId) as {role?:string}|undefined
      if(currentUser?.role!=='admin')return send(res,403,{error:'Somente administradores podem redistribuir trabalhos entre perfis.'})
      const b=await jsonBody(req) as Record<string,unknown>
      const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(Number).filter(Number.isInteger))]:[]
      const accountId=Number(b.accountId)
      if(!ids.length)return send(res,400,{error:'Selecione pelo menos um trabalho.'})
      const target=db.prepare('SELECT id FROM social_accounts WHERE id=? AND organization_id=?').get(accountId,auth.organizationId)
      if(!target)return send(res,400,{error:'Selecione um perfil de destino válido.'})
      const placeholders=ids.map(()=>'?').join(',')
      const jobs=db.prepare(`SELECT id,vehicle_id vehicleId,social_account_id accountId,status,queue_priority priority FROM publication_jobs
        WHERE organization_id=? AND id IN (${placeholders}) ORDER BY queue_priority,id`).all(auth.organizationId,...ids) as Array<{id:number;vehicleId:number;accountId:number;status:string;priority:number}>
      if(jobs.length!==ids.length)return send(res,400,{error:'Um ou mais trabalhos não pertencem a esta empresa.'})
      if(jobs.some(job=>!['pending','error','awaiting_confirmation'].includes(job.status)))return send(res,409,{error:'Trabalhos em preenchimento ou encerrados não podem ser redistribuídos.'})
      if(jobs.some(job=>job.accountId===accountId))return send(res,400,{error:'Escolha um perfil diferente do perfil atual.'})
      const transferredVehicleIds=jobs.map(job=>job.vehicleId)
      const duplicatePlaceholders=transferredVehicleIds.map(()=>'?').join(',')
      const duplicate=db.prepare(`SELECT id FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND vehicle_id IN (${duplicatePlaceholders})
        AND status IN ('pending','filling','error','awaiting_confirmation') AND id NOT IN (${placeholders}) LIMIT 1`)
        .get(auth.organizationId,accountId,...transferredVehicleIds,...ids)
      if(duplicate)return send(res,409,{error:'O perfil de destino já possui um trabalho ativo para um dos veículos selecionados.'})
      const settings=db.prepare('SELECT daily_limit dailyLimit FROM organization_settings WHERE organization_id=?').get(auth.organizationId) as {dailyLimit:number}|undefined
      const today=(db.prepare("SELECT COUNT(*) total FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND date(created_at)=date('now') AND status!='canceled'").get(auth.organizationId,accountId) as {total:number}).total
      if(today+jobs.length>Number(settings?.dailyLimit||10))return send(res,429,{error:`A transferência ultrapassaria o limite diário de ${settings?.dailyLimit||10} trabalhos do perfil de destino.`})
      let nextPriority=((db.prepare(`SELECT COALESCE(MAX(queue_priority),0)+1 value FROM publication_jobs WHERE organization_id=? AND social_account_id=?
        AND status IN ('pending','filling','error','awaiting_confirmation')`).get(auth.organizationId,accountId) as {value:number}).value)||1
      db.exec('BEGIN')
      try{
        for(const job of jobs){
          db.prepare(`UPDATE publication_jobs SET social_account_id=?,queue_priority=?,extension_visible=1,paused=0,updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND organization_id=?`).run(accountId,nextPriority++,job.id,auth.organizationId)
          recordJobEvent(auth.organizationId,job.id,'reassigned',auth.userId,{queuePriority:nextPriority-1},job.accountId,accountId)
        }
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(res,200,{updated:jobs.length,accountId})
    }
    const queuePriority=url.pathname.match(/^\/api\/publications\/(\d+)\/priority$/)
    if(req.method==='PATCH'&&queuePriority){
      const b=await jsonBody(req) as Record<string,unknown>,direction=String(b.direction)
      if(!['up','down'].includes(direction))return send(res,400,{error:'Direção inválida.'})
      const current=db.prepare(`SELECT id,social_account_id accountId,queue_priority priority,status FROM publication_jobs
        WHERE id=? AND organization_id=?`).get(Number(queuePriority[1]),auth.organizationId) as {id:number;accountId:number;priority:number;status:string}|undefined
      if(!current)return send(res,404,{error:'Trabalho não encontrado.'})
      if(!['pending','error','awaiting_confirmation'].includes(current.status))return send(res,409,{error:'Este trabalho não pode ser reordenado agora.'})
      const comparator=direction==='up'?'<':'>'
      const order=direction==='up'?'DESC':'ASC'
      const neighbor=db.prepare(`SELECT id,queue_priority priority FROM publication_jobs WHERE organization_id=? AND social_account_id=?
        AND status IN ('pending','error','awaiting_confirmation') AND queue_priority ${comparator} ? ORDER BY queue_priority ${order},id ${order} LIMIT 1`)
        .get(auth.organizationId,current.accountId,current.priority) as {id:number;priority:number}|undefined
      if(!neighbor)return send(res,200,{ok:true,moved:false})
      db.exec('BEGIN')
      try{
        db.prepare('UPDATE publication_jobs SET queue_priority=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(neighbor.priority,current.id,auth.organizationId)
        db.prepare('UPDATE publication_jobs SET queue_priority=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(current.priority,neighbor.id,auth.organizationId)
        recordJobEvent(auth.organizationId,current.id,'priority_changed',auth.userId,{direction,from:current.priority,to:neighbor.priority})
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(res,200,{ok:true,moved:true})
    }
    const publicationSchedule=url.pathname.match(/^\/api\/publications\/(\d+)\/schedule$/)
    if(req.method==='PATCH'&&publicationSchedule){
      const b=await jsonBody(req) as Record<string,unknown>
      const job=db.prepare('SELECT id,status FROM publication_jobs WHERE id=? AND organization_id=?').get(Number(publicationSchedule[1]),auth.organizationId) as {id:number;status:string}|undefined
      if(!job)return send(res,404,{error:'Trabalho não encontrado.'})
      if(!['pending','error','awaiting_confirmation'].includes(job.status))return send(res,409,{error:'Este trabalho não pode ser agendado agora.'})
      let scheduledAt:string|null=null
      if(String(b.scheduledAt||'').trim()){
        const timestamp=Date.parse(String(b.scheduledAt))
        if(!Number.isFinite(timestamp)||timestamp<Date.now()+60000)return send(res,400,{error:'Escolha um horário com pelo menos um minuto de antecedência.'})
        scheduledAt=new Date(timestamp).toISOString()
      }
      db.prepare('UPDATE publication_jobs SET scheduled_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(scheduledAt,job.id,auth.organizationId)
      recordJobEvent(auth.organizationId,job.id,scheduledAt?'scheduled':'schedule_removed',auth.userId,{scheduledAt})
      return send(res,200,{ok:true,scheduledAt})
    }
    if(req.method==='PATCH'&&url.pathname==='/api/publications/schedule-batch'){
      const b=await jsonBody(req) as Record<string,unknown>
      const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(Number).filter(Number.isInteger))].slice(0,50):[]
      if(ids.length<2)return send(res,400,{error:'Selecione pelo menos dois trabalhos para criar uma sequência.'})
      const startTimestamp=Date.parse(String(b.startAt||'')),intervalMinutes=Math.floor(Number(b.intervalMinutes))
      if(!Number.isFinite(startTimestamp)||startTimestamp<Date.now()+60000)return send(res,400,{error:'Escolha um primeiro horário com pelo menos um minuto de antecedência.'})
      if(!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)return send(res,400,{error:'O intervalo deve ficar entre 1 minuto e 24 horas.'})
      const placeholders=ids.map(()=>'?').join(',')
      const rows=db.prepare(`SELECT id,status,social_account_id accountId FROM publication_jobs WHERE organization_id=? AND id IN (${placeholders})`).all(auth.organizationId,...ids) as Array<{id:number;status:string;accountId:number}>
      if(rows.length!==ids.length)return send(res,400,{error:'Um ou mais trabalhos não pertencem a esta empresa.'})
      if(rows.some(job=>!['pending','error','awaiting_confirmation'].includes(job.status)))return send(res,409,{error:'Trabalhos em preenchimento ou encerrados não podem ser agendados.'})
      const byId=new Map(rows.map(job=>[job.id,job])),intervalMs=intervalMinutes*60000
      const existing=db.prepare(`SELECT social_account_id accountId,scheduled_at scheduledAt FROM publication_jobs WHERE organization_id=? AND scheduled_at IS NOT NULL
        AND datetime(scheduled_at)>CURRENT_TIMESTAMP AND id NOT IN (${placeholders}) AND status IN ('pending','error','awaiting_confirmation')`).all(auth.organizationId,...ids) as Array<{accountId:number;scheduledAt:string}>
      const occupied=new Map<number,number[]>()
      for(const item of existing){const timestamp=Date.parse(item.scheduledAt);if(Number.isFinite(timestamp))occupied.set(item.accountId,[...(occupied.get(item.accountId)||[]),timestamp])}
      const assignments=ids.map((id,index)=>{
        const job=byId.get(id)!,profileTimes=occupied.get(job.accountId)||[]
        let timestamp=startTimestamp+index*intervalMs
        while(profileTimes.some(value=>Math.abs(value-timestamp)<intervalMs))timestamp+=intervalMs
        profileTimes.push(timestamp);occupied.set(job.accountId,profileTimes)
        return{id,accountId:job.accountId,scheduledAt:new Date(timestamp).toISOString(),position:index+1}
      })
      db.exec('BEGIN')
      try{
        for(const assignment of assignments){
          db.prepare('UPDATE publication_jobs SET scheduled_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(assignment.scheduledAt,assignment.id,auth.organizationId)
          recordJobEvent(auth.organizationId,assignment.id,'batch_scheduled',auth.userId,{scheduledAt:assignment.scheduledAt,intervalMinutes,position:assignment.position,total:assignments.length})
        }
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(res,200,{ok:true,updated:assignments.length,intervalMinutes,assignments})
    }
    const publication = url.pathname.match(/^\/api\/publications\/(\d+)$/)
    if (req.method === 'PATCH' && publication) {
      const b = await jsonBody(req) as Record<string,unknown>
      const allowed = ['pending','filling','awaiting_confirmation','completed','error','canceled','removed']
      if (!allowed.includes(String(b.status))) return send(res,400,{error:'Status inválido.'})
      const job=db.prepare('SELECT vehicle_id vehicleId,fill_report fillReport FROM publication_jobs WHERE id=? AND organization_id=?').get(Number(publication[1]),auth.organizationId) as {vehicleId:number;fillReport?:string}|undefined
      if(!job)return send(res,404,{error:'Publicação não encontrada.'})
      let previousReport:Record<string,unknown>={}
      try{previousReport=job.fillReport?JSON.parse(job.fillReport):{}}catch{/* relatório antigo inválido */}
      if(String(b.status)==='pending'&&previousReport.publishAttempted&&b.confirmNoPublication!==true)return send(res,409,{error:'Antes de repetir, verifique em “Seus classificados” se o anúncio foi criado. Confirme no painel que ele NÃO foi publicado para liberar uma nova tentativa.'})
      db.exec('BEGIN')
      try{
        if(String(b.status)==='pending')db.prepare("UPDATE publication_jobs SET status='pending',paused=0,extension_visible=1,error_code=NULL,fill_report='',started_at=NULL,filled_at=NULL,removed_at=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(Number(publication[1]),auth.organizationId)
        else if(String(b.status)==='removed')db.prepare("UPDATE publication_jobs SET status='removed',removed_at=CURRENT_TIMESTAMP,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(Number(publication[1]),auth.organizationId)
        else db.prepare('UPDATE publication_jobs SET status=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(String(b.status),Number(publication[1]),auth.organizationId)
        if(String(b.status)==='completed')db.prepare("UPDATE vehicles SET status='Publicado',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(job.vehicleId,auth.organizationId)
        const eventType:Record<string,string>={pending:'retry_requested',filling:'filling_started',awaiting_confirmation:'filled_waiting_confirmation',completed:'confirmed_published',error:'fill_error',canceled:'canceled',removed:'marked_removed'}
        recordJobEvent(auth.organizationId,Number(publication[1]),eventType[String(b.status)]||'status_changed',auth.userId,{status:String(b.status)})
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(res,200,{ok:true})
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const organization = db.prepare('SELECT id,name FROM organizations WHERE id=?').get(auth.organizationId)
      const settings = db.prepare(`SELECT default_location defaultLocation,daily_limit dailyLimit,stuck_timeout_minutes stuckTimeoutMinutes,
        require_confirmation requireConfirmation,description_template descriptionTemplate,auto_advance autoAdvance,
        fill_groups fillGroups,target_groups targetGroups,auto_publish autoPublish FROM organization_settings WHERE organization_id=?`).get(auth.organizationId) as Record<string,unknown>
      try { settings.targetGroups=JSON.parse(String(settings.targetGroups||'[]')) } catch { settings.targetGroups=[] }
      settings.groups=marketplaceGroups(auth.organizationId)
      return send(res,200,{organization,settings})
    }
    if (req.method === 'PATCH' && url.pathname === '/api/settings') {
      const current = userById(auth.userId) as {role?:string} | undefined
      if (current?.role !== 'admin') return send(res,403,{error:'Somente administradores podem alterar configurações.'})
      const b = await jsonBody(req) as Record<string,unknown>
      if (!String(b.organizationName||'').trim()) return send(res,400,{error:'O nome da empresa é obrigatório.'})
      const limit = Math.max(1,Math.min(50,Number(b.dailyLimit)||10))
      const stuckTimeoutMinutes=Math.max(1,Math.min(120,Number(b.stuckTimeoutMinutes)||15))
      const autoAdvance=b.autoAdvance===true
      const fillGroups=b.fillGroups===true
      const autoPublish=b.autoPublish===true
      const targetGroups=Array.isArray(b.targetGroups)?[...new Set(b.targetGroups.map(value=>String(value).trim()).filter(Boolean))].slice(0,20):[]
      const groupRecords=Array.isArray(b.groups)?b.groups:targetGroups
      if(groupRecords.some((value:unknown)=>!validateGroupTarget(value)))return send(res,400,{error:'Informe um nome e uma URL valida do Facebook para cada grupo.'})
      if(fillGroups&&!autoAdvance)return send(res,400,{error:'Ative o avanço automático para selecionar grupos.'})
      if(fillGroups&&!groupRecords.some((value:unknown)=>validateGroupTarget(value)&&(typeof value==='string'||(Boolean(value)&&typeof value==='object'&&(value as Record<string,unknown>).active!==false))))return send(res,400,{error:'Mantenha pelo menos um grupo ativo para preencher.'})
      if(autoPublish&&!autoAdvance)return send(res,400,{error:'Ative o avanço automático antes da publicação automática.'})
      db.prepare('UPDATE organizations SET name=? WHERE id=?').run(String(b.organizationName).trim(),auth.organizationId)
      db.prepare(`UPDATE organization_settings SET default_location=?,daily_limit=?,stuck_timeout_minutes=?,require_confirmation=?,description_template=?,auto_advance=?,fill_groups=?,target_groups=?,auto_publish=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`)
        .run(String(b.defaultLocation||''),limit,stuckTimeoutMinutes,autoPublish?0:1,String(b.descriptionTemplate||''),autoAdvance?1:0,fillGroups?1:0,JSON.stringify(targetGroups),autoPublish?1:0,auth.organizationId)
      const groups=replaceMarketplaceGroups(auth.organizationId,groupRecords)
      return send(res,200,{ok:true,groups})
    }
    if (req.method === 'POST' && url.pathname === '/api/team/users') {
      const current = userById(auth.userId) as {role?:string} | undefined
      if (current?.role !== 'admin') return send(res,403,{error:'Somente administradores podem adicionar usuários.'})
      const b = await jsonBody(req) as Record<string,unknown>
      if (!b.name || !b.email || !b.password) return send(res,400,{error:'Nome, e-mail e senha temporária são obrigatórios.'})
      if (String(b.password).length < 8) return send(res,400,{error:'A senha temporária deve ter pelo menos 8 caracteres.'})
      try {
        const result = db.prepare('INSERT INTO users (organization_id,name,email,password_hash,role) VALUES (?,?,?,?,?)')
          .run(auth.organizationId,String(b.name),String(b.email).toLowerCase(),hashPassword(String(b.password)),b.role === 'admin' ? 'admin' : 'seller')
        return send(res,201,{id:Number(result.lastInsertRowid)})
      } catch (error) {
        if (String(error).includes('UNIQUE')) return send(res,409,{error:'Este e-mail já está cadastrado.'})
        throw error
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/social-accounts') {
      const current = userById(auth.userId) as {role?:string}|undefined
      if(current?.role!=='admin')return send(res,403,{error:'Somente administradores podem associar perfis do Brave.'})
      const b = await jsonBody(req) as Record<string,unknown>
      const owner = db.prepare('SELECT id FROM users WHERE id=? AND organization_id=?').get(Number(b.userId),auth.organizationId)
      if (!owner) return send(res,400,{error:'O responsável selecionado não pertence à empresa.'})
      if (!b.label || !b.browserProfile) return send(res,400,{error:'Rótulo e perfil do Brave são obrigatórios.'})
      const result = db.prepare(`INSERT INTO social_accounts (organization_id,user_id,label,browser_profile,status)
        VALUES (?,?,?,?, 'not_connected')`).run(auth.organizationId,Number(b.userId),String(b.label),String(b.browserProfile))
      return send(res,201,{id:Number(result.lastInsertRowid)})
    }
    return send(res,404,{error:'Rota não encontrada.'})
  } catch (error) {
    console.error(error); return send(res,500,{error:'Erro interno da aplicação.'})
  }
}).listen(port, () => console.log(`API AutoFlow em http://localhost:${port}`))
