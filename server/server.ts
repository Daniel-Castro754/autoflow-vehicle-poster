import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(root, 'data')
mkdirSync(dataDir, { recursive: true })
const uploadsDir = join(dataDir, 'uploads')
mkdirSync(uploadsDir, { recursive: true })
const db = new DatabaseSync(join(dataDir, 'autoflow.db'))
const secret = process.env.AUTH_SECRET || 'dev-only-change-before-production'
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
`)

function ensureColumn(table:string,column:string,definition:string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>
  if (!columns.some(item=>item.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
ensureColumn('vehicles','vehicle_type',"TEXT NOT NULL DEFAULT 'Carro/Caminhonete'")
ensureColumn('vehicles','location',"TEXT NOT NULL DEFAULT ''")
ensureColumn('vehicles','transmission',"TEXT NOT NULL DEFAULT 'Automático'")
ensureColumn('vehicles','fuel_type',"TEXT NOT NULL DEFAULT 'Flex'")
ensureColumn('vehicles','body_type',"TEXT NOT NULL DEFAULT 'Sedã'")
ensureColumn('vehicles','exterior_color',"TEXT NOT NULL DEFAULT ''")
ensureColumn('vehicles','description',"TEXT NOT NULL DEFAULT ''")
ensureColumn('publication_jobs','fill_report',"TEXT NOT NULL DEFAULT ''")
ensureColumn('publication_jobs','extension_version',"TEXT NOT NULL DEFAULT ''")
ensureColumn('publication_jobs','started_at','TEXT')
ensureColumn('publication_jobs','filled_at','TEXT')

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
function send(res:ServerResponse, status:number, data:unknown) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, Authorization', 'Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS' })
  res.end(JSON.stringify(data))
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
  const org = db.prepare('INSERT INTO organizations (name) VALUES (?)').run('AutoPrime Veículos')
  const orgId = Number(org.lastInsertRowid)
  const admin = db.prepare('INSERT INTO users (organization_id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run(orgId,'Daniel Costa','admin@autoflow.local',hashPassword('demo1234'),'admin')
  const adminId = Number(admin.lastInsertRowid)
  const marina = db.prepare('INSERT INTO users (organization_id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run(orgId,'Marina Costa','marina@autoflow.local',hashPassword('demo1234'),'seller')
  const rows = [
    [2022,'Toyota','Corolla','XEi 2.0',119900,42500,Number(marina.lastInsertRowid),'Pronto','#dce8ef','São Paulo, SP','2022 Toyota Corolla XEi 2.0 com 42.500 km. Único dono, revisões em dia.'],
    [2021,'Jeep','Compass','Longitude',134500,51820,adminId,'Publicado','#dedbd3','São Paulo, SP','2021 Jeep Compass Longitude com 51.820 km. Completo, pneus novos.'],
    [2023,'Volkswagen','T-Cross','Comfortline',128900,22300,Number(marina.lastInsertRowid),'Rascunho','#d9e2e6','São Paulo, SP','2023 Volkswagen T-Cross Comfortline com 22.300 km.'],
    [2020,'Honda','Civic','Touring',139990,68100,adminId,'Atenção','#e7e4de','São Paulo, SP','2020 Honda Civic Touring com 68.100 km. Revisar documentação antes de publicar.'],
    [2024,'Chevrolet','Tracker','Premier',154900,8900,adminId,'Pronto','#d9e0df','São Paulo, SP','2024 Chevrolet Tracker Premier com 8.900 km. Seminovo, garantia de fábrica.'],
  ]
  const insert = db.prepare('INSERT INTO vehicles (organization_id,year,make,model,trim,price,km,assigned_user_id,status,color,location,description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const row of rows) insert.run(orgId,...row)
}
db.exec(`INSERT OR IGNORE INTO organization_settings (organization_id,default_location,daily_limit,require_confirmation,description_template)
  SELECT id,'São Paulo, SP',10,1,'{ano} {marca} {modelo} {versao} com {km} km. Entre em contato para consultar disponibilidade.' FROM organizations`)
// Repairs values written by an early Windows encoding issue in the development seed.
db.prepare("UPDATE organizations SET name='AutoPrime Veículos' WHERE name='AutoPrime Ve'||char(65533)||'culos'").run()
db.prepare("UPDATE organization_settings SET default_location='São Paulo, SP' WHERE default_location='S'||char(65533)||'o Paulo, SP'").run()

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, null)
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    const uploadFile = url.pathname.match(/^\/uploads\/([a-f0-9]{24}\.(?:jpg|jpeg|png|webp))$/)
    if (req.method === 'GET' && uploadFile) {
      const path = join(uploadsDir,uploadFile[1])
      if (!existsSync(path)) return send(res,404,{error:'Imagem não encontrada.'})
      const ext = uploadFile[1].split('.').pop()
      const mime = ext==='png'?'image/png':ext==='webp'?'image/webp':'image/jpeg'
      res.writeHead(200,{'Content-Type':mime,'Access-Control-Allow-Origin':'*','Cache-Control':'public, max-age=3600'})
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
        v.exterior_color exteriorColor,v.description,
        COALESCE(u.name,'Não atribuído') seller,
        CASE WHEN u.name IS NULL THEN '—' ELSE substr(u.name,1,1)||substr(u.name,instr(u.name,' ')+1,1) END initials,
        v.updated_at updatedAt,(SELECT COUNT(*) FROM vehicle_images i WHERE i.vehicle_id=v.id) imageCount,
        (SELECT 'http://127.0.0.1:3333/uploads/'||i.file_name FROM vehicle_images i WHERE i.vehicle_id=v.id ORDER BY i.position,i.id LIMIT 1) thumbnailUrl
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
      const jobs = db.prepare(`SELECT j.id jobId,j.vehicle_id vehicleId,j.status jobStatus,j.error_code errorCode,j.updated_at updatedAt,
        v.year,v.make,v.model,v.trim,v.price,v.km,v.status vehicleStatus,
        (SELECT COUNT(*) FROM vehicle_images i WHERE i.vehicle_id=v.id) imageCount,
        COALESCE(u.name,'Não atribuído') seller,a.label accountLabel
        FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id
        JOIN social_accounts a ON a.id=j.social_account_id LEFT JOIN users u ON u.id=v.assigned_user_id
        WHERE j.organization_id=? AND j.social_account_id=? AND j.status IN ('pending','filling','error')
        ORDER BY CASE j.status WHEN 'error' THEN 0 WHEN 'filling' THEN 1 ELSE 2 END,j.created_at`).all(auth.organizationId,accountId)
      return send(res,200,{account,jobs})
    }
    const extensionPrepare = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/prepare$/)
    if (req.method === 'POST' && extensionPrepare) {
      const b=await jsonBody(req) as {accountId?:number}
      const accountId=Number(b.accountId)
      if (!allowedExtensionAccount(accountId,auth)) return send(res,403,{error:'Este perfil do Brave não está disponível para o usuário conectado.'})
      const job = db.prepare(`SELECT j.id,j.vehicle_id vehicleId,j.status FROM publication_jobs j
        WHERE j.id=? AND j.organization_id=? AND j.social_account_id=?`).get(Number(extensionPrepare[1]),auth.organizationId,accountId) as {id:number;vehicleId:number;status:string}|undefined
      if (!job) return send(res,404,{error:'Trabalho não encontrado para este perfil.'})
      if (!['pending','filling','error'].includes(job.status)) return send(res,409,{error:'Este trabalho não está disponível para preenchimento.'})
      const vehicle = db.prepare(`SELECT v.id,v.year,v.make,v.model,v.trim,v.price,v.km,v.status,
        v.vehicle_type vehicleType,v.location,v.transmission,v.fuel_type fuelType,v.body_type bodyType,v.exterior_color exteriorColor,
        printf('%d %s %s %s',v.year,v.make,v.model,v.trim) title,
        CASE WHEN length(v.description)>0 THEN v.description ELSE printf('%d %s %s %s com %d km. Entre em contato para consultar disponibilidade e condições.',v.year,v.make,v.model,v.trim,v.km) END description
        FROM vehicles v WHERE v.id=? AND v.organization_id=?`).get(job.vehicleId,auth.organizationId)
      if (!vehicle) return send(res,404,{error:'Veículo não encontrado.'})
      const images = db.prepare(`SELECT 'http://127.0.0.1:3333/uploads/'||file_name url,original_name name,mime_type mimeType FROM vehicle_images WHERE vehicle_id=? AND organization_id=? ORDER BY position,id LIMIT 20`).all(job.vehicleId,auth.organizationId)
      db.prepare(`UPDATE publication_jobs SET status='filling',error_code=NULL,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`).run(job.id,auth.organizationId)
      return send(res,200,{jobId:job.id,accountId,vehicle:{...vehicle,images}})
    }
    const extensionFillResult = url.pathname.match(/^\/api\/extension\/jobs\/(\d+)\/fill-result$/)
    if (req.method === 'PATCH' && extensionFillResult) {
      const b=await jsonBody(req) as Record<string,unknown>
      const job = db.prepare(`SELECT j.id,j.social_account_id accountId FROM publication_jobs j
        WHERE j.id=? AND j.organization_id=?`).get(Number(extensionFillResult[1]),auth.organizationId) as {id:number;accountId:number}|undefined
      if (!job || !allowedExtensionAccount(job.accountId,auth)) return send(res,404,{error:'Trabalho não encontrado para este perfil.'})
      const error=String(b.error||'').slice(0,240)
      if (error) {
        db.prepare(`UPDATE publication_jobs SET status='error',error_code=?,extension_version=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
          .run(error,String(b.extensionVersion||'').slice(0,30),job.id,auth.organizationId)
        return send(res,200,{ok:true,status:'error'})
      }
      const report={
        filledCount:Math.max(0,Number(b.filledCount)||0),totalCount:Math.max(0,Number(b.totalCount)||0),
        imageCount:Math.max(0,Number(b.imageCount)||0),missing:Array.isArray(b.missing)?b.missing.map(String).slice(0,30):[],
        fields:Array.isArray(b.fields)?b.fields.slice(0,30):[]
      }
      db.prepare(`UPDATE publication_jobs SET status='awaiting_confirmation',fill_report=?,extension_version=?,error_code=NULL,filled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
        .run(JSON.stringify(report),String(b.extensionVersion||'').slice(0,30),job.id,auth.organizationId)
      return send(res,200,{ok:true,status:'awaiting_confirmation'})
    }
    if (req.method === 'POST' && url.pathname === '/api/vehicles') {
      const b = await jsonBody(req) as Record<string,unknown>
      if (!b.make || !b.model || !b.year) return send(res,400,{error:'Marca, modelo e ano são obrigatórios.'})
      const result = db.prepare(`INSERT INTO vehicles (organization_id,year,make,model,trim,price,km,status,assigned_user_id,vehicle_type,location,transmission,fuel_type,body_type,exterior_color,description)
        VALUES (?,?,?,?,?,?,?,'Rascunho',?,?,?,?,?,?,?,?)`).run(auth.organizationId,Number(b.year),String(b.make),String(b.model),String(b.trim||''),Number(b.price||0),Number(b.km||0),auth.userId,String(b.vehicleType||'Carro/Caminhonete'),String(b.location||''),String(b.transmission||'Automático'),String(b.fuelType||'Flex'),String(b.bodyType||'Sedã'),String(b.exteriorColor||''),String(b.description||''))
      return send(res,201,{id:Number(result.lastInsertRowid)})
    }
    const vehicleRoute = url.pathname.match(/^\/api\/vehicles\/(\d+)$/)
    if (req.method === 'PATCH' && vehicleRoute) {
      const b = await jsonBody(req) as Record<string,unknown>
      const result = db.prepare(`UPDATE vehicles SET year=?,make=?,model=?,trim=?,price=?,km=?,vehicle_type=?,location=?,transmission=?,fuel_type=?,body_type=?,exterior_color=?,description=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
        .run(Number(b.year),String(b.make||''),String(b.model||''),String(b.trim||''),Number(b.price||0),Number(b.km||0),String(b.vehicleType||'Carro/Caminhonete'),String(b.location||''),String(b.transmission||''),String(b.fuelType||''),String(b.bodyType||''),String(b.exteriorColor||''),String(b.description||''),String(b.status||'Rascunho'),Number(vehicleRoute[1]),auth.organizationId)
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
      writeFileSync(join(uploadsDir,fileName),bytes)
      const position = (db.prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM vehicle_images WHERE vehicle_id=?').get(vehicleId) as {next:number}).next
      const result = db.prepare('INSERT INTO vehicle_images (organization_id,vehicle_id,file_name,original_name,mime_type,position) VALUES (?,?,?,?,?,?)').run(auth.organizationId,vehicleId,fileName,String(b.name||fileName),mime,position)
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
      const ids = (b.ids||[]).map(Number).filter(Number.isInteger)
      if (!ids.length) return send(res,400,{error:'Selecione pelo menos um veículo.'})
      const owned = db.prepare(`SELECT id FROM vehicles WHERE organization_id=? AND id IN (${ids.map(()=>'?').join(',')})`).all(auth.organizationId,...ids) as Array<{id:number}>
      db.exec('BEGIN')
      try {
        for (const item of owned) {
          const images = db.prepare('SELECT file_name fileName FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').all(item.id,auth.organizationId) as Array<{fileName:string}>
          for (const image of images) { const path=join(uploadsDir,image.fileName); if(existsSync(path))unlinkSync(path) }
          db.prepare('DELETE FROM publication_jobs WHERE vehicle_id=? AND organization_id=?').run(item.id,auth.organizationId)
          db.prepare('DELETE FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').run(item.id,auth.organizationId)
          db.prepare('DELETE FROM vehicles WHERE id=? AND organization_id=?').run(item.id,auth.organizationId)
        }
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      return send(res,200,{deleted:owned.length})
    }
    if (req.method === 'GET' && url.pathname === '/api/team') {
      const users = db.prepare('SELECT id,name,email,role FROM users WHERE organization_id=? ORDER BY name').all(auth.organizationId)
      const accounts = db.prepare('SELECT id,user_id userId,label,platform,status,browser_profile browserProfile,last_seen_at lastSeenAt FROM social_accounts WHERE organization_id=?').all(auth.organizationId)
      return send(res,200,{users,accounts})
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
    if (req.method === 'GET' && url.pathname === '/api/publications') {
      const rows = db.prepare(`SELECT j.id,j.status,j.result_url resultUrl,j.error_code errorCode,j.fill_report fillReport,
        j.extension_version extensionVersion,j.started_at startedAt,j.filled_at filledAt,j.created_at createdAt,j.updated_at updatedAt,
        v.id vehicleId,v.year,v.make,v.model,v.price,COALESCE(a.label,'Perfil não definido') accountLabel,
        COALESCE(u.name,'Não atribuído') seller FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id
        LEFT JOIN social_accounts a ON a.id=j.social_account_id LEFT JOIN users u ON u.id=v.assigned_user_id
        WHERE j.organization_id=? ORDER BY j.created_at DESC`).all(auth.organizationId)
      const jobs=rows.map((item:any)=>{try{return{...item,fillReport:item.fillReport?JSON.parse(item.fillReport):null}}catch{return{...item,fillReport:null}}})
      return send(res,200,{jobs})
    }
    if (req.method === 'POST' && url.pathname === '/api/publications') {
      const b = await jsonBody(req) as Record<string,unknown>
      const vehicle = db.prepare('SELECT id,price,km,location,description FROM vehicles WHERE id=? AND organization_id=?').get(Number(b.vehicleId),auth.organizationId) as {id:number;price:number;km:number;location:string;description:string}|undefined
      if (!vehicle) return send(res,400,{error:'Veículo inválido.'})
      const imageCount = (db.prepare('SELECT COUNT(*) c FROM vehicle_images WHERE vehicle_id=? AND organization_id=?').get(vehicle.id,auth.organizationId) as {c:number}).c
      const missing:string[] = []
      if (!(vehicle.price>0)) missing.push('Preço')
      if (!(vehicle.km>0)) missing.push('Quilometragem')
      if (!vehicle.location.trim()) missing.push('Localização')
      if (!vehicle.description.trim()) missing.push('Descrição')
      if (!imageCount) missing.push('Fotos')
      if (missing.length) {
        db.prepare("UPDATE vehicles SET status='Atenção',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(vehicle.id,auth.organizationId)
        return send(res,422,{error:'Complete os dados obrigatórios antes de publicar.',missing})
      }
      const accountId=Number(b.accountId)
      if (!Number.isInteger(accountId)||!db.prepare('SELECT id FROM social_accounts WHERE id=? AND organization_id=?').get(accountId,auth.organizationId)) return send(res,400,{error:'Selecione o perfil do Brave que publicará este veículo.'})
      const duplicate = db.prepare("SELECT id FROM publication_jobs WHERE organization_id=? AND vehicle_id=? AND social_account_id=? AND status IN ('pending','filling','awaiting_confirmation')").get(auth.organizationId,Number(b.vehicleId),accountId)
      if (duplicate) return send(res,409,{error:'Este veículo já possui um trabalho ativo para o perfil selecionado.'})
      const settings=db.prepare('SELECT daily_limit dailyLimit FROM organization_settings WHERE organization_id=?').get(auth.organizationId) as {dailyLimit:number}|undefined
      const today=(db.prepare("SELECT COUNT(*) total FROM publication_jobs WHERE organization_id=? AND social_account_id=? AND date(created_at)=date('now') AND status!='canceled'").get(auth.organizationId,accountId) as {total:number}).total
      if(today>=Number(settings?.dailyLimit||10))return send(res,429,{error:`O perfil atingiu o limite diário de ${settings?.dailyLimit||10} trabalhos.`})
      const result = db.prepare('INSERT INTO publication_jobs (organization_id,vehicle_id,social_account_id,status) VALUES (?,?,?,?)').run(auth.organizationId,Number(b.vehicleId),accountId,'pending')
      db.prepare("UPDATE vehicles SET status='Pronto',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(Number(b.vehicleId),auth.organizationId)
      return send(res,201,{id:Number(result.lastInsertRowid)})
    }
    const publication = url.pathname.match(/^\/api\/publications\/(\d+)$/)
    if (req.method === 'PATCH' && publication) {
      const b = await jsonBody(req) as Record<string,unknown>
      const allowed = ['pending','filling','awaiting_confirmation','completed','error','canceled']
      if (!allowed.includes(String(b.status))) return send(res,400,{error:'Status inválido.'})
      const job=db.prepare('SELECT vehicle_id vehicleId FROM publication_jobs WHERE id=? AND organization_id=?').get(Number(publication[1]),auth.organizationId) as {vehicleId:number}|undefined
      if(!job)return send(res,404,{error:'Publicação não encontrada.'})
      db.exec('BEGIN')
      try{
        if(String(b.status)==='pending')db.prepare("UPDATE publication_jobs SET status='pending',error_code=NULL,fill_report='',started_at=NULL,filled_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(Number(publication[1]),auth.organizationId)
        else db.prepare('UPDATE publication_jobs SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?').run(String(b.status),Number(publication[1]),auth.organizationId)
        if(String(b.status)==='completed')db.prepare("UPDATE vehicles SET status='Publicado',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").run(job.vehicleId,auth.organizationId)
        db.exec('COMMIT')
      }catch(error){db.exec('ROLLBACK');throw error}
      return send(res,200,{ok:true})
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const organization = db.prepare('SELECT id,name FROM organizations WHERE id=?').get(auth.organizationId)
      const settings = db.prepare(`SELECT default_location defaultLocation,daily_limit dailyLimit,
        require_confirmation requireConfirmation,description_template descriptionTemplate FROM organization_settings WHERE organization_id=?`).get(auth.organizationId)
      return send(res,200,{organization,settings})
    }
    if (req.method === 'PATCH' && url.pathname === '/api/settings') {
      const current = userById(auth.userId) as {role?:string} | undefined
      if (current?.role !== 'admin') return send(res,403,{error:'Somente administradores podem alterar configurações.'})
      const b = await jsonBody(req) as Record<string,unknown>
      if (!String(b.organizationName||'').trim()) return send(res,400,{error:'O nome da empresa é obrigatório.'})
      const limit = Math.max(1,Math.min(50,Number(b.dailyLimit)||10))
      db.prepare('UPDATE organizations SET name=? WHERE id=?').run(String(b.organizationName).trim(),auth.organizationId)
      db.prepare(`UPDATE organization_settings SET default_location=?,daily_limit=?,require_confirmation=?,description_template=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`)
        .run(String(b.defaultLocation||''),limit,b.requireConfirmation===false?0:1,String(b.descriptionTemplate||''),auth.organizationId)
      return send(res,200,{ok:true})
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
