import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// 1. Testes unitários dos algoritmos autônomos
import { calculateBackoff, withRetry } from '../server/lib/retry.ts'
import { generateVehicleDescription } from '../server/services/description-generator.ts'
import { generateVehicleHashtags } from '../server/services/trending-hashtags.ts'
import { calculateOptimalSchedule } from '../server/services/smart-scheduler.ts'
import { DatabaseSync } from 'node:sqlite'
import { curateMarketplaceGroups, evaluateGroupScore } from '../server/services/group-curator.ts'
import { findBestAccountForVehicle } from '../server/services/session-manager.ts'
import { parseVehicleRawText } from '../server/services/ai-agent.ts'

console.log('--- Iniciando Testes Unitários de Algoritmos Autônomos ---')

// 1.1 Retry & Backoff com Jitter
{
  const backoff1 = calculateBackoff(1, 120000, 1800000)
  assert(backoff1 >= 120000 && backoff1 <= 150000, `Backoff attempt 1 inesperado: ${backoff1}`)

  const backoff2 = calculateBackoff(2, 120000, 1800000)
  assert(backoff2 >= 240000 && backoff2 <= 260000, `Backoff attempt 2 inesperado: ${backoff2}`)

  let attemptCount = 0
  const retryResult = await withRetry(async () => {
    attemptCount++
    if (attemptCount < 2) throw new Error('Falha simulada transitória')
    return 'sucesso'
  }, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 })

  assert.equal(retryResult, 'sucesso')
  assert.equal(attemptCount, 2)
  console.log('✓ Retry com Backoff e Jitter validado com sucesso.')
}

// 1.2 Gerador de Descrições IA + Fallback Procedural
{
  const vehicleData = {
    make: 'Toyota',
    model: 'Corolla',
    trim: '2.0 XEi Flex 16V',
    year: 2022,
    price: 125000,
    km: 45000,
    location: 'São Paulo - SP',
    transmission: 'Automático',
    fuelType: 'Flex',
    exteriorColor: 'Prata',
    condition: 'Excelente',
  }

  const descResult = await generateVehicleDescription(vehicleData, {
    tone: 'vendedor',
  })
  const hashtags = generateVehicleHashtags(vehicleData)

  assert(descResult.description.includes('Toyota Corolla'), 'Descrição deve conter marca e modelo')
  assert(descResult.description.includes('45.000 km'), 'Descrição deve conter quilometragem formatada')
  assert(hashtags.length > 0, 'Deve gerar hashtags')
  assert(hashtags.some(t => t.toLowerCase() === '#toyota'), 'Deve conter tag da marca')
  assert(hashtags.some(t => t.toLowerCase() === '#corolla'), 'Deve conter tag do modelo')
  console.log('✓ Gerador de Descrições com fallback inteligente e hashtags validado.')
}

// 1.3 Smart Scheduler com Janelas de Pico Brasileiras e Anti-Bot Jitter
{
  const now = new Date()
  const optimal = calculateOptimalSchedule({
    fromTime: now,
    existingTimestamps: [],
    accountId: 1,
  })

  assert(optimal.scheduledAt > now, 'Agendamento deve ser no futuro')
  assert(optimal.isoString.length > 0, 'Deve gerar ISO string')
  assert(optimal.confidence === 'peak_heuristic', 'Deve utilizar heurística de pico')
  assert(typeof optimal.jitterMinutes === 'number', 'Deve incluir jitter em minutos')

  // Teste de prevenção de colisão: se houver horário muito próximo, deve avançar
  const collisionTarget = optimal.scheduledAt.getTime()
  const withCollision = calculateOptimalSchedule({
    fromTime: now,
    existingTimestamps: [collisionTarget],
    accountId: 1,
  })
  assert(Math.abs(withCollision.scheduledAt.getTime() - collisionTarget) >= 20 * 60000, 'Não deve colidir com agendamento existente')
  console.log('✓ Smart Scheduler de janelas de pico com anti-colisão validado.')
}

// 1.4 Curadoria e Scoring de Grupos
{
  const testGroupReliable = {
    id: 1,
    name: 'Classificados Carros SP',
    url: 'https://facebook.com/groups/spcarros',
    active: true,
    priority: 1,
    successCount: 95,
    failureCount: 5,
    lastFoundAt: new Date().toISOString(),
  }

  const testGroupFailing = {
    id: 2,
    name: 'Troca de Carros Qualquer',
    url: 'https://facebook.com/groups/trocacarros',
    active: true,
    priority: 2,
    successCount: 5,
    failureCount: 45,
    lastFoundAt: new Date(Date.now() - 30 * 86400000).toISOString(),
  }

  const scoreHigh = evaluateGroupScore(testGroupReliable, 'São Paulo').score
  const scoreLow = evaluateGroupScore(testGroupFailing, 'São Paulo').score

  assert(scoreHigh > scoreLow, `Grupo confiável (${scoreHigh}) deve ter score maior que grupo falho (${scoreLow})`)

  const curated = curateMarketplaceGroups([testGroupFailing, testGroupReliable], 'São Paulo', 5)
  assert.equal(curated[0].group.id, 1, 'Grupo mais confiável deve ser o primeiro colocado')
  console.log('✓ Curadoria inteligente de grupos do Marketplace validada.')
}

// 1.5 Roteamento Autônomo de Sessões e Load Balancing
{
  const memDb = new DatabaseSync(':memory:')
  memDb.exec(`
    CREATE TABLE organization_settings (organization_id INTEGER PRIMARY KEY, daily_limit INTEGER);
    CREATE TABLE social_accounts (id INTEGER PRIMARY KEY, organization_id INTEGER, label TEXT, browser_profile TEXT, status TEXT, last_seen_at TEXT);
    CREATE TABLE publication_jobs (id INTEGER PRIMARY KEY, organization_id INTEGER, social_account_id INTEGER, vehicle_id INTEGER, status TEXT, created_at TEXT);
    INSERT INTO organization_settings VALUES (1, 10);
    INSERT INTO social_accounts VALUES (1, 1, 'Perfil 1', 'Profile 1', 'active', datetime('now'));
    INSERT INTO social_accounts VALUES (2, 1, 'Perfil 2', 'Profile 2', 'active', datetime('now'));
    -- Perfil 1 com 5 jobs hoje
    INSERT INTO publication_jobs VALUES (101, 1, 1, 991, 'completed', datetime('now', 'localtime'));
    INSERT INTO publication_jobs VALUES (102, 1, 1, 992, 'completed', datetime('now', 'localtime'));
    INSERT INTO publication_jobs VALUES (103, 1, 1, 993, 'completed', datetime('now', 'localtime'));
    INSERT INTO publication_jobs VALUES (104, 1, 1, 994, 'completed', datetime('now', 'localtime'));
    INSERT INTO publication_jobs VALUES (105, 1, 1, 995, 'completed', datetime('now', 'localtime'));
  `)

  const bestAccount = findBestAccountForVehicle(memDb, 1, 50)
  assert.equal(bestAccount?.id, 2, 'Deve selecionar perfil 2 com menor utilização hoje')
  console.log('✓ Roteador de contas e balanceamento autônomo validado.')
}

// 1.6 Leitor Inteligente de Veículos (Parser de Texto Cru)
{
  const parsed = parseVehicleRawText('Vendo urgente Corolla XEi 2022 prata flex automatico com 42.500 km revisado na css R$ 119.900 SP')
  assert.equal(parsed.year, 2022)
  assert.equal(parsed.make, 'Toyota')
  assert.equal(parsed.model, 'Corolla')
  assert.equal(parsed.trim, 'XEi')
  assert.equal(parsed.km, 42500)
  assert.equal(parsed.price, 119900)
  assert.equal(parsed.exteriorColor, 'Prata')
  assert.equal(parsed.transmission, 'Automático')
  assert.equal(parsed.fuelType, 'Flex')
  console.log('✓ Parser inteligente de texto cru de veículos validado.')
}

console.log('\n--- Iniciando Testes de Integração com Servidor Live ---')

const port = 3444
const base = `http://127.0.0.1:${port}/api`
const dataDir = await mkdtemp(join(tmpdir(), 'autoflow-autonomous-test-'))
const adminEmail = 'admin-auto@autoflow.local'
const adminPassword = 'admin-auto-password-strong'
const jpegBase64 = value => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(value)]).toString('base64')

const server = spawn(process.execPath, ['server/server.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    AUTH_SECRET: 'autonomous-test-secret-at-least-32-chars-ok',
    INITIAL_ADMIN_NAME: 'Admin Autônomo',
    INITIAL_ADMIN_EMAIL: adminEmail,
    INITIAL_ADMIN_PASSWORD: adminPassword,
    LOGIN_MAX_ATTEMPTS: '10',
    LOGIN_WINDOW_SECONDS: '60',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverOutput = ''
server.stdout.on('data', chunk => serverOutput += chunk)
server.stderr.on('data', chunk => serverOutput += chunk)

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(base + '/health')
      if (response.ok) return
    } catch {
      // aguardando inicialização
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`A API de teste não iniciou: ${serverOutput}`)
}

async function call(path, token, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  })
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(`${response.status} ${path}: ${data.error}`), { status: response.status, body: data })
  return data
}

try {
  await waitForServer()

  // Login
  const loginRes = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  })
  const { token } = await loginRes.json()
  assert(token, 'Deve obter token de autenticação')

  // 2.1 Watchdog & Detailed Health Check
  const healthDetailed = await call('/health/detailed', token)
  assert.equal(healthDetailed.ok, true)
  assert.equal(typeof healthDetailed.healthy, 'boolean')
  assert.equal(typeof healthDetailed.stuckJobsCount, 'number')
  assert.equal(typeof healthDetailed.recoveredCount, 'number')
  console.log('✓ Health Check Detalhado com métricas de Watchdog validado.')

  // 2.2 Endpoint de Geração de Descrições IA
  const aiDesc = await call('/ai/generate-description', token, {
    method: 'POST',
    body: JSON.stringify({
      vehicle: {
        make: 'Honda',
        model: 'Civic',
        version: 'Touring 1.5 Turbo',
        year: 2021,
        price: 139900,
        km: 38000,
        transmission: 'Automático',
        color: 'Branco Pérola',
      },
      tone: 'vendedor',
      includeHashtags: true,
    }),
  })
  assert(aiDesc.ok)
  assert(aiDesc.description.includes('Honda Civic'))
  assert(aiDesc.hashtags.some(t => t.toLowerCase() === '#honda'))
  console.log('✓ Endpoint POST /api/ai/generate-description validado.')

  // 2.3 Atualização e Leitura de Configurações Autônomas
  const updateSettings = await call('/settings', token, {
    method: 'PATCH',
    body: JSON.stringify({
      organizationName: 'AutoFlow Autônomo Multimarcas',
      defaultLocation: 'Curitiba - PR',
      dailyLimit: 20,
      stuckTimeoutMinutes: 10,
      autoAdvance: true,
      fillGroups: true,
      autoPublish: false,
      autoRetry: true,
      maxRetries: 4,
      alertTelegramToken: 'test_telegram_bot_token_123456',
      alertTelegramChatId: '-1009988776655',
      alertWebhookUrl: 'http://127.0.0.1:3444/api/health', // URL válida local para o teste
      autoCurateGroups: true,
      groups: [
        { name: 'Feirão de Automóveis Curitiba', url: 'https://facebook.com/groups/curitibacarros', active: true },
        { name: 'Classificados Paraná Veículos', url: 'https://facebook.com/groups/prveiculos', active: true },
      ],
    }),
  })
  assert.equal(updateSettings.ok, true)

  const settings = await call('/settings', token)
  assert.equal(settings.organization.name, 'AutoFlow Autônomo Multimarcas')
  assert.equal(settings.settings.autoRetry, 1)
  assert.equal(settings.settings.maxRetries, 4)
  assert.equal(settings.settings.autoCurateGroups, 1)
  assert.equal(settings.settings.alertTelegramToken, 'test_telegram_bot_token_123456')
  console.log('✓ Persistência de configurações autônomas (autoRetry, maxRetries, Telegram, Webhook) validada.')

  // 2.4 Teste de Disparo de Alerta Crítico
  const alertTest = await call('/alerts/test', token, { method: 'POST' })
  assert.equal(alertTest.ok, true)
  assert.equal(typeof alertTest.result.telegram, 'boolean')
  assert.equal(typeof alertTest.result.webhook, 'boolean')
  console.log('✓ Endpoint POST /api/alerts/test e despachante de alertas validados.')

  // 2.5 Curadoria de Grupos via API
  const curateRes = await call('/groups/auto-curate', token, { method: 'POST' })
  assert.equal(curateRes.ok, true)
  assert(curateRes.curatedCount >= 2)
  console.log('✓ Endpoint POST /api/groups/auto-curate validado.')

  // 2.6 Cadastro de Perfil Social e Veículo para testes de Fila Autônoma
  const team = await call('/team', token)
  const adminUser = team.users[0]
  const accountRes = await call('/social-accounts', token, {
    method: 'POST',
    body: JSON.stringify({
      userId: adminUser.id,
      label: 'Perfil Operacional 1',
      browserProfile: 'Profile 1',
    }),
  })
  const accountId = accountRes.id

  const vehicleRes = await call('/vehicles', token, {
    method: 'POST',
    body: JSON.stringify({
      make: 'Volkswagen',
      model: 'Golf',
      trim: 'Highline',
      year: 2018,
      price: 92000,
      km: 62000,
      vehicleType: 'Carro/picape',
      bodyType: 'Hatch',
      condition: 'Excelente',
      transmission: 'Automático',
      fuelType: 'Gasolina',
      exteriorColor: 'Prateado',
      interiorColor: 'Preto',
      status: 'Pronto',
      description: 'Golf impecável teto solar.',
      location: 'São Paulo, SP',
    }),
  })
  const vehicleId = vehicleRes.id
  await call(`/vehicles/${vehicleId}/images`, token, {
    method: 'POST',
    body: JSON.stringify({
      name: 'golf-1.jpg',
      mimeType: 'image/jpeg',
      dataBase64: jpegBase64('golf-foto-1'),
    }),
  })

  // 2.7 Criação de Publicação com Roteamento e Agendamento Inteligente
  const publicationRes = await call('/publications', token, {
    method: 'POST',
    body: JSON.stringify({
      vehicleId,
      smartSchedule: true,
    }),
  })
  assert(publicationRes.id > 0, 'Publicação deve ser criada com ID positivo')
  assert(publicationRes.scheduledAt, 'Publicação inteligente deve vir agendada')
  assert(publicationRes.accountId > 0, 'Deve rotear automaticamente para perfil válido')
  const jobId = publicationRes.id
  console.log(`✓ Criação autônoma de publicação com smartSchedule (Job #${jobId}) validada.`)

  // 2.8 Endpoint Individual de Smart Schedule
  const singleSchedule = await call(`/publications/${jobId}/smart-schedule`, token, { method: 'POST' })
  assert.equal(singleSchedule.ok, true)
  assert(singleSchedule.scheduledAt)
  assert(singleSchedule.window)
  console.log('✓ Endpoint POST /api/publications/:id/smart-schedule validado.')

  // 2.9 Endpoint em Lote de Smart Schedule
  const batchSchedule = await call('/publications/smart-schedule-batch', token, {
    method: 'POST',
    body: JSON.stringify({ ids: [jobId] }),
  })
  assert.equal(batchSchedule.ok, true)
  assert.equal(batchSchedule.updated, 1)
  console.log('✓ Endpoint POST /api/publications/smart-schedule-batch validado.')

  // 2.10 Auto-Retry com Backoff Exponencial e Jitter na Extensão
  // Liberar agendamento para execução imediata
  await call(`/publications/${jobId}/schedule`, token, {
    method: 'PATCH',
    body: JSON.stringify({ scheduledAt: null }),
  })

  // Bloqueia e prepara o trabalho para a extensão
  const prepared = await call(`/extension/jobs/${jobId}/prepare`, token, {
    method: 'POST',
    body: JSON.stringify({
      accountId,
      instanceId: 'auto_test_ext_instance',
    }),
  })
  assert(prepared.leaseToken, 'Deve gerar leaseToken exclusivo para a execução')

  // Reportar erro transitório acionando auto-retry
  const fillFailRes = await call(`/extension/jobs/${jobId}/fill-result`, token, {
    method: 'PATCH',
    body: JSON.stringify({
      leaseToken: prepared.leaseToken,
      error: 'Elemento do Facebook não respondeu a tempo (timeout simulado).',
      autoRetry: true,
      extensionVersion: '2.5.0',
    }),
  })
  assert.equal(fillFailRes.ok, true)
  assert.equal(fillFailRes.status, 'pending')
  assert.equal(fillFailRes.autoRetry, true)
  assert(fillFailRes.scheduledAt, 'Deve reagendar para o futuro com backoff')

  // Verificar na listagem de publicações se retryCount e novo agendamento foram refletidos
  const pubDetails = await call('/publications', token)
  const myJob = pubDetails.jobs.find(j => j.id === jobId)
  assert(myJob, 'Trabalho deve constar na listagem')
  assert.equal(myJob.retryCount, 1, 'retryCount deve ser 1 na API')
  assert.equal(myJob.status, 'pending', 'Status deve permanecer pendente para reexecução futura')
  assert(myJob.scheduledAt, 'scheduledAt deve estar preenchido')
  console.log('✓ Auto-Retry com backoff exponencial e reagendamento autônomo validado.')

  // Testes da Nova Central e API de IA (Leitura, Auditoria, Otimização, Comandos e Piloto Automático)
  // 1. Parser de Texto Cru via API
  const parseRes = await call('/ai/parse-text', token, {
    method: 'POST',
    body: JSON.stringify({ text: 'Jeep Compass Longitude 2021 preto flex automatico 51800 km R$ 134.500 SP' }),
  })
  assert.equal(parseRes.ok, true)
  assert.equal(parseRes.vehicle.make, 'Jeep')
  assert.equal(parseRes.vehicle.model, 'Compass')
  assert.equal(parseRes.vehicle.year, 2021)
  console.log('✓ Endpoint POST /api/ai/parse-text validado.')

  // 2. Auditoria do Estoque
  const auditRes = await call('/ai/audit', token)
  assert.equal(auditRes.ok, true)
  assert(auditRes.audit.healthScore >= 0 && auditRes.audit.healthScore <= 100)
  assert(Array.isArray(auditRes.audit.recommendations))
  console.log('✓ Endpoint GET /api/ai/audit com Health Score validado.')

  // 3. Otimização em Lote de Descrições
  const batchOptRes = await call('/ai/batch-optimize', token, {
    method: 'POST',
    body: JSON.stringify({ tone: 'profissional' }),
  })
  assert.equal(batchOptRes.ok, true)
  assert(typeof batchOptRes.updated === 'number')
  console.log('✓ Endpoint POST /api/ai/batch-optimize validado.')

  // 4. Comandos em Linguagem Natural do Agente
  const cmdAuditRes = await call('/ai/command', token, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'auditar saúde do estoque' }),
  })
  assert.equal(cmdAuditRes.ok, true)
  assert.equal(cmdAuditRes.intent, 'audit')
  assert(cmdAuditRes.reply.length > 0)

  const cmdOptRes = await call('/ai/command', token, {
    method: 'POST',
    body: JSON.stringify({ prompt: 'otimizar textos dos carros em tom vendedor' }),
  })
  assert.equal(cmdOptRes.ok, true)
  assert.equal(cmdOptRes.intent, 'optimize_descriptions')
  console.log('✓ Endpoint POST /api/ai/command com despachante NLP validado.')

  // 5. Piloto Automático (Autopilot)
  const autopilotRes = await call('/ai/autopilot/run', token, { method: 'POST' })
  assert.equal(autopilotRes.ok, true)
  assert(typeof autopilotRes.jobsCreated === 'number')
  console.log('✓ Endpoint POST /api/ai/autopilot/run (Pipeline 100% Autônomo) validado.')

  console.log('\n======================================================')
  console.log(' TODOS OS TESTES DA ARQUITETURA AUTÔNOMA PASSARAM! (100%)')
  console.log('======================================================')
} catch (err) {
  console.error('\n❌ Erro durante execução dos testes autônomos:', err)
  console.error('\n--- SERVER OUTPUT ---\n', serverOutput)
  process.exitCode = 1
} finally {
  server.kill()
}
