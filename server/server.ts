import { servePanel } from './services/static-panel.ts'
import { hashPassword, verifyPassword } from './lib/passwords.ts'
import { open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto'
import { logger } from './lib/logger.ts'
import { startGroupCurationWorker } from './services/group-curation-worker.ts'
import { startHealthMonitor, stopHealthMonitor } from './services/health-monitor.ts'
import { createAutonomousScheduler } from './services/autonomous-scheduler.ts'
import { handleOperationsRoute } from './routes/operations.ts'
import { handleInterventionsRoute } from './routes/interventions.ts'
import { recordOperationalSignal } from './services/operational-incidents.ts'
import { requestIdFor, withRequestContext } from './lib/request-context.ts'
import { vehicleOptions } from './services/vehicle-input.ts'
import { publicationDuplicateRisk as findPublicationDuplicateRisk } from './services/publication-policy.ts'
import { createAccessControl } from './services/access-control.ts'
import { createMarketplaceGroupService } from './services/marketplace-groups.ts'
import { applyMigrations } from './database/migrations.ts'
import { initializeBaseSchema } from './database/schema.ts'
import { handleAIRoute } from './routes/ai.ts'
import { initializeCredentialVault, migrateCredentials } from './services/credential-vault.ts'
import { handleGroupsRoute } from './routes/groups.ts'
import { handlePublicationSchedulingRoute } from './routes/publication-scheduling.ts'
import { handleOrganizationRoute } from './routes/organization.ts'
import { handleAuthRoute } from './routes/auth.ts'
import { createGoogleSignIn } from './services/google-sign-in.ts'
import { createAutomationStatements, handleDashboardRoute } from './routes/dashboard.ts'
import {
  createVehiclePageStatements,
  handleVehicleMutationRoute,
  handleVehicleReadRoute,
} from './routes/vehicles.ts'
import { handleExtensionRoute, isExtensionRoute } from './routes/extension.ts'
import { handlePublicationReadRoute, isPublicationReadRoute } from './routes/publication-reads.ts'
import {
  handlePublicationManagementRoute,
  isPublicationManagementRoute,
} from './routes/publication-management.ts'
import { handleAlertRoute } from './routes/alerts.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const configuredSecret = process.env.AUTH_SECRET?.trim()
if (!configuredSecret || configuredSecret.length < 32)
  throw new Error('AUTH_SECRET deve ter pelo menos 32 caracteres.')
const secret = configuredSecret
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(root, 'data')
mkdirSync(dataDir, { recursive: true })
const uploadsDir = join(dataDir, 'uploads')
mkdirSync(uploadsDir, { recursive: true })
const db = new DatabaseSync(join(dataDir, 'autoflow.db'))
const port = Number(process.env.PORT || 3333)
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT deve ser um número inteiro entre 1 e 65535.')
const host = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1'
const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
const publicOrigin = String(process.env.PUBLIC_ORIGIN || `http://${urlHost}:${port}`)
  .trim()
  .replace(/\/+$/, '')
const parsedPublicOrigin = new URL(publicOrigin)
if (
  !['http:', 'https:'].includes(parsedPublicOrigin.protocol) ||
  parsedPublicOrigin.pathname !== '/'
)
  throw new Error('PUBLIC_ORIGIN deve conter apenas uma origem HTTP ou HTTPS válida.')
const imageBaseUrl = `${publicOrigin}/uploads/`

initializeBaseSchema(db)
applyMigrations(db)
initializeCredentialVault(dataDir)
migrateCredentials(db)
const automationStatements = createAutomationStatements(db)
const vehiclePageStatements = createVehiclePageStatements(db)
const {
  parseGroupTarget,
  validateGroupTarget,
  groupTarget,
  marketplaceGroups,
  replaceMarketplaceGroups,
} = createMarketplaceGroupService(db)

for (const image of db
  .prepare(
    "SELECT id,file_name fileName FROM vehicle_images WHERE content_hash='' OR content_hash IS NULL",
  )
  .all() as Array<{ id: number; fileName: string }>) {
  const path = join(uploadsDir, image.fileName)
  if (existsSync(path))
    db.prepare('UPDATE vehicle_images SET content_hash=? WHERE id=?').run(
      createHash('sha256').update(readFileSync(path)).digest('hex'),
      image.id,
    )
}

function recordJobEvent(
  organizationId: number,
  publicationJobId: number,
  eventType: string,
  createdBy: number | null = null,
  details: Record<string, unknown> = {},
  fromAccountId: number | null = null,
  toAccountId: number | null = null,
) {
  let serialized = '{}'
  try {
    serialized = JSON.stringify(details).slice(0, 8000)
  } catch {
    /* detalhes opcionais */
  }
  db.prepare(
    `INSERT INTO publication_job_events (organization_id,publication_job_id,event_type,from_account_id,to_account_id,created_by,details)
    VALUES (?,?,?,?,?,?,?)`,
  ).run(
    organizationId,
    publicationJobId,
    eventType,
    fromAccountId,
    toAccountId,
    createdBy,
    serialized,
  )
  recordOperationalSignal(db, organizationId, publicationJobId, eventType, details, createdBy)
}

function publicationDuplicateRisk(organizationId: number, vehicleId: number, excludeJobId = 0) {
  return findPublicationDuplicateRisk(db, organizationId, vehicleId, excludeJobId)
}

const dummyPasswordHash = await hashPassword(randomBytes(32).toString('hex'))
const authRouteDependencies = {
  db,
  send,
  jsonBody,
  userById,
  verifyPassword,
  dummyPasswordHash,
  sign,
  googleSignIn: createGoogleSignIn(),
}
function sign(payload: object) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + 12 * 60 * 60 * 1000 }),
  ).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}
function readToken(req: IncomingMessage) {
  const token = req.headers.authorization?.replace(/^Bearer /, '')
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const valid = createHmac('sha256', secret).update(body).digest('base64url')
  if (sig.length !== valid.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(valid)))
    return null
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString())
    return value.exp > Date.now() ? value : null
  } catch {
    return null
  }
}
function activeSession(auth: { userId: number; organizationId: number; sessionId?: string }) {
  return Boolean(
    auth.sessionId &&
    db
      .prepare(
        `SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=? AND s.user_id=? AND s.organization_id=? AND s.revoked_at IS NULL
      AND datetime(s.expires_at)>CURRENT_TIMESTAMP AND u.active=1`,
      )
      .get(auth.sessionId, auth.userId, auth.organizationId),
  )
}
const JSON_BODY_LIMIT = 1024 * 1024
class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
async function jsonBody(req: IncomingMessage, maxBytes = JSON_BODY_LIMIT) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new HttpError(413, 'O corpo da requisição excede o limite permitido.')
  const chunks: Buffer[] = []
  let size = 0,
    tooLarge = false
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      tooLarge = true
      continue
    }
    chunks.push(buffer)
  }
  if (tooLarge) throw new HttpError(413, 'O corpo da requisição excede o limite permitido.')
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'O corpo da requisição não contém JSON válido.')
  }
}
const configuredOrigins = new Set(
  (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
)
function applyCors(req: IncomingMessage, res: ServerResponse) {
  const origin = String(req.headers.origin || '')
  const allowed =
    !origin ||
    origin === publicOrigin ||
    configuredOrigins.has(origin) ||
    /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
  if (origin) res.setHeader('Vary', 'Origin')
  if (origin && allowed) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id')
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  return allowed
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function userById(id: number) {
  return db
    .prepare('SELECT id, organization_id organizationId, name, email, role FROM users WHERE id = ?')
    .get(id)
}
const {
  isAdmin,
  canWriteVehicle,
  refreshVehiclePublicationStatus,
  jobsIncludeSoldVehicle,
  canWriteImage,
  canManageJobs,
  allowedExtensionAccount,
} = createAccessControl(db, userById)

if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
  const adminName = String(process.env.INITIAL_ADMIN_NAME || 'Administrador').trim()
  const adminEmail = String(process.env.INITIAL_ADMIN_EMAIL || '')
    .trim()
    .toLowerCase()
  const adminPassword = String(process.env.INITIAL_ADMIN_PASSWORD || '')
  if (!adminName || !adminEmail.includes('@') || adminPassword.length < 12)
    throw new Error(
      'Banco vazio: configure INITIAL_ADMIN_EMAIL e INITIAL_ADMIN_PASSWORD (mínimo de 12 caracteres).',
    )
  const org = db
    .prepare('INSERT INTO organizations (name) VALUES (?)')
    .run(String(process.env.INITIAL_ORGANIZATION_NAME || 'AutoFlow').trim() || 'AutoFlow')
  const orgId = Number(org.lastInsertRowid)
  const admin = db
    .prepare('INSERT INTO users (organization_id,name,email,password_hash,role) VALUES (?,?,?,?,?)')
    .run(orgId, adminName, adminEmail, await hashPassword(adminPassword), 'admin')
  const adminId = Number(admin.lastInsertRowid)
  const rows = [
    [
      2022,
      'Toyota',
      'Corolla',
      'XEi 2.0',
      119900,
      42500,
      adminId,
      'Pronto',
      '#dce8ef',
      'São Paulo, SP',
      '2022 Toyota Corolla XEi 2.0 com 42.500 km. Único dono, revisões em dia.',
    ],
    [
      2021,
      'Jeep',
      'Compass',
      'Longitude',
      134500,
      51820,
      adminId,
      'Publicado',
      '#dedbd3',
      'São Paulo, SP',
      '2021 Jeep Compass Longitude com 51.820 km. Completo, pneus novos.',
    ],
    [
      2023,
      'Volkswagen',
      'T-Cross',
      'Comfortline',
      128900,
      22300,
      adminId,
      'Rascunho',
      '#d9e2e6',
      'São Paulo, SP',
      '2023 Volkswagen T-Cross Comfortline com 22.300 km.',
    ],
    [
      2020,
      'Honda',
      'Civic',
      'Touring',
      139990,
      68100,
      adminId,
      'Atenção',
      '#e7e4de',
      'São Paulo, SP',
      '2020 Honda Civic Touring com 68.100 km. Revisar documentação antes de publicar.',
    ],
    [
      2024,
      'Chevrolet',
      'Tracker',
      'Premier',
      154900,
      8900,
      adminId,
      'Pronto',
      '#d9e0df',
      'São Paulo, SP',
      '2024 Chevrolet Tracker Premier com 8.900 km. Seminovo, garantia de fábrica.',
    ],
  ]
  const insert = db.prepare(
    'INSERT INTO vehicles (organization_id,year,make,model,trim,price,km,assigned_user_id,status,color,location,description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  )
  for (const row of rows) insert.run(orgId, ...row)
}
db.exec(`INSERT OR IGNORE INTO organization_settings (organization_id,default_location,daily_limit,require_confirmation,description_template)
  SELECT id,'São Paulo, SP',10,1,'{ano} {marca} {modelo} {versao} com {km} km. Entre em contato para mais informações.' FROM organizations`)
for (const organization of db.prepare('SELECT id FROM organizations').all() as Array<{
  id: number
}>) {
  if (!marketplaceGroups(organization.id).length) {
    const settings = db
      .prepare(
        'SELECT target_groups targetGroups FROM organization_settings WHERE organization_id=?',
      )
      .get(organization.id) as { targetGroups?: string } | undefined
    try {
      const legacy = JSON.parse(String(settings?.targetGroups || '[]'))
      if (Array.isArray(legacy) && legacy.length) replaceMarketplaceGroups(organization.id, legacy)
    } catch {
      /* configuração antiga inválida */
    }
  }
}
startHealthMonitor(db, 60000)
startGroupCurationWorker(db)
const autopilotScheduler = createAutonomousScheduler(db)
autopilotScheduler.start()

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const originAllowed = applyCors(req, res)
  if (req.method === 'OPTIONS')
    return originAllowed ? send(res, 204, null) : send(res, 403, { error: 'Origem não permitida.' })
  if (!originAllowed) return send(res, 403, { error: 'Origem não permitida.' })
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/health/live')
      return send(res, 200, { status: 'alive', timestamp: new Date().toISOString() })
    if (req.method === 'GET' && url.pathname === '/health/ready') {
      try {
        db.prepare('SELECT 1 value').get()
        return send(res, 200, { status: 'ready', timestamp: new Date().toISOString() })
      } catch {
        return send(res, 503, { status: 'not_ready', timestamp: new Date().toISOString() })
      }
    }
    const uploadFile = url.pathname.match(/^\/uploads\/([a-f0-9]{24}\.(?:jpg|jpeg|png|webp))$/)
    if (req.method === 'GET' && uploadFile) {
      const path = join(uploadsDir, uploadFile[1])
      const file = await open(path, 'r').catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!file) return send(res, 404, { error: 'Imagem não encontrada.' })
      try {
        const info = await file.stat()
        const ext = uploadFile[1].split('.').pop()
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': info.size,
          'Cache-Control': 'public, max-age=86400, immutable',
          'X-Content-Type-Options': 'nosniff',
        })
        await pipeline(file.createReadStream({ autoClose: false }), res)
      } finally {
        await file.close()
      }
      return
    }
    if (await servePanel(req, res, url, join(root, 'dist'))) return
    if (await handleAuthRoute(req, res, url, undefined, authRouteDependencies)) return
    const auth = readToken(req)
    if (!auth) return send(res, 401, { error: 'Sessão inválida ou expirada.' })
    if (!activeSession(auth))
      return send(res, 401, { error: 'Esta sessão foi encerrada ou revogada. Entre novamente.' })
    if (await handleAuthRoute(req, res, url, auth, authRouteDependencies)) return
    if (
      await handleInterventionsRoute(req, res, url, auth, {
        db,
        send,
        jsonBody,
        isAdmin,
      })
    )
      return
    if (handleOperationsRoute(req, res, url, auth, db, send)) return
    if (
      handleVehicleReadRoute(req, res, url, auth, {
        send,
        imageBaseUrl,
        validStatuses: vehicleOptions.status,
        pageStatements: vehiclePageStatements,
      })
    )
      return
    if (isExtensionRoute(req, url)) {
      await handleExtensionRoute(req, res, url, auth, {
        db,
        send,
        jsonBody,
        userById,
        allowedExtensionAccount,
        marketplaceGroups,
        groupTarget,
        jobsIncludeSoldVehicle,
        publicationDuplicateRisk,
        recordJobEvent,
        refreshVehiclePublicationStatus,
        parseGroupTarget,
        imageBaseUrl,
      })
      return
    }
    if (
      await handleVehicleMutationRoute(req, res, url, auth, {
        db,
        send,
        jsonBody,
        imageBaseUrl,
        uploadsDir,
        isAdmin,
        canWriteVehicle,
        canWriteImage,
        recordJobEvent,
      })
    )
      return
    if (handleDashboardRoute(req, res, url, auth, db, send, automationStatements, isAdmin)) return
    if (isPublicationReadRoute(req, url)) {
      await handlePublicationReadRoute(req, res, url, auth, { db, send, userById, recordJobEvent })
      return
    }
    if (isPublicationManagementRoute(req, url)) {
      await handlePublicationManagementRoute(req, res, url, auth, {
        db,
        send,
        jsonBody,
        userById,
        canWriteVehicle,
        canManageJobs,
        jobsIncludeSoldVehicle,
        allowedExtensionAccount,
        publicationDuplicateRisk,
        recordJobEvent,
        refreshVehiclePublicationStatus,
      })
      return
    }
    if (
      await handleOrganizationRoute(req, res, url, auth, {
        db,
        send,
        jsonBody,
        isAdmin,
        hashPassword,
        marketplaceGroups,
        validateGroupTarget,
        replaceMarketplaceGroups,
      })
    )
      return
    if (await handleAIRoute(req, res, url, auth, { db, send, jsonBody, isAdmin })) return
    if (
      await handlePublicationSchedulingRoute(req, res, url, auth, {
        db,
        send,
        jsonBody,
        canManageJobs,
        recordJobEvent,
      })
    )
      return
    if (
      await handleGroupsRoute(req, res, url, auth, {
        db,
        send,
        isAdmin,
        marketplaceGroups,
        groupTarget,
      })
    )
      return
    if (await handleAlertRoute(req, res, url, auth, { db, send, isAdmin })) return
    return send(res, 404, { error: 'Rota não encontrada.' })
  } catch (error) {
    if (res.headersSent || res.destroyed) {
      res.destroy()
      return
    }
    if (error instanceof HttpError) return send(res, error.status, { error: error.message })
    logger.error('Server', 'Erro não tratado na requisição', { error })
    return send(res, 500, { error: 'Erro interno da aplicação.' })
  }
}
const server = createServer((req, res) => {
  const requestId = requestIdFor(req.headers['x-request-id'])
  res.setHeader('X-Request-Id', requestId)
  const started = performance.now()
  res.once('finish', () =>
    withRequestContext(requestId, () => {
      logger.info('HTTP', 'Requisição concluída', {
        method: req.method,
        path: (req.url || '/')
          .split('?')[0]
          .replace(/\/\d+(?=\/|$)/g, '/:id')
          .slice(0, 160),
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
      })
    }),
  )
  void withRequestContext(requestId, () => handleRequest(req, res))
})
server.on('close', () => {
  autopilotScheduler.stop()
  stopHealthMonitor()
})
server.requestTimeout = 30_000
server.headersTimeout = 10_000
server.keepAliveTimeout = 5_000
server.listen(port, host, () => logger.info('Server', `API AutoFlow em ${publicOrigin}`))
