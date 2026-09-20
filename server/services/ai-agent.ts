import type { DatabaseSync } from 'node:sqlite'
import { generateVehicleDescription, type VehicleInput, type CopyTone } from './description-generator.ts'
import { generateVehicleHashtags } from './trending-hashtags.ts'
import { calculateOptimalSchedule } from './smart-scheduler.ts'
import { findBestAccountForVehicle } from './session-manager.ts'
import { curateMarketplaceGroups } from './group-curator.ts'

export interface ParsedVehicle {
  year: number
  make: string
  model: string
  trim: string
  km: number
  price: number
  transmission: string
  fuelType: string
  exteriorColor: string
  location: string
  description: string
  confidence: number
}

export interface InventoryAudit {
  healthScore: number
  totalVehicles: number
  readyVehicles: number
  publishedVehicles: number
  unoptimizedDescriptions: number
  missingPhotos: number
  readyUnscheduled: number
  activeAccounts: number
  peakWindowAvailable: string
  recommendations: Array<{
    severity: 'info' | 'warning' | 'critical'
    title: string
    description: string
    actionText?: string
    actionIntent?: string
  }>
}

export interface AutopilotResult {
  ok: boolean
  processedCount: number
  jobsCreated: number
  descriptionsOptimized: number
  assignments: Array<{
    vehicleId: number
    title: string
    accountId: number
    accountLabel: string
    scheduledAt: string
    window: string
  }>
  message: string
}

export interface AgentCommandResult {
  ok: boolean
  intent: string
  reply: string
  actionTaken?: string
  details?: unknown
}

const BRAZILIAN_MAKES = [
  'Chevrolet', 'Volkswagen', 'Fiat', 'Ford', 'Toyota', 'Honda', 'Hyundai',
  'Jeep', 'Renault', 'Nissan', 'BMW', 'Mercedes-Benz', 'Mercedes', 'Audi',
  'Peugeot', 'Citroën', 'Citroen', 'Mitsubishi', 'Caoa Chery', 'Chery',
  'Kia', 'Volvo', 'Land Rover', 'RAM', 'Porsche', 'BYD', 'GWM'
]

const POPULAR_MODELS: Record<string, string[]> = {
  Toyota: ['Corolla', 'Hilux', 'Yaris', 'Etios', 'RAV4', 'Corolla Cross', 'SW4'],
  Honda: ['Civic', 'Fit', 'HR-V', 'City', 'WR-V', 'CR-V'],
  Jeep: ['Compass', 'Renegade', 'Commander'],
  Volkswagen: ['Gol', 'Polo', 'T-Cross', 'Nivus', 'Virtus', 'Taos', 'Jetta', 'Fox', 'Saveiro', 'Amarok', 'Up'],
  Chevrolet: ['Onix', 'Tracker', 'Prisma', 'Cruze', 'Spin', 'S10', 'Montana', 'Cobalt'],
  Fiat: ['Strada', 'Toro', 'Mobi', 'Argo', 'Cronos', 'Pulse', 'Fastback', 'Uno', 'Palio', 'Siena'],
  Hyundai: ['HB20', 'Creta', 'Tucson', 'i30'],
  Renault: ['Kwid', 'Sandero', 'Duster', 'Logan', 'Captur', 'Oroch'],
  Nissan: ['Kicks', 'Versa', 'March', 'Sentra', 'Frontier'],
  Ford: ['Ka', 'EcoSport', 'Ranger', 'Fiesta', 'Focus', 'Fusion'],
  BMW: ['320i', 'X1', 'X3', '328i', '118i'],
}

/**
 * Parses unstructured text (WhatsApp ad, web copy, notes) into structured vehicle fields.
 */
export function parseVehicleRawText(rawText: string): ParsedVehicle {
  const text = String(rawText || '').trim()
  if (!text) {
    throw new Error('O texto para análise não pode estar vazio.')
  }

  // 1. Detect Year
  let year = new Date().getFullYear()
  const yearMatch = text.match(/\b(19\d{2}|20\d{2})(?:\/(?:19\d{2}|20\d{2}|\d{2}))?\b/)
  if (yearMatch) {
    year = Number.parseInt(yearMatch[1], 10)
  } else {
    const shortYearMatch = text.match(/\b(\d{2})\/(\d{2})\b/)
    if (shortYearMatch) {
      const parsed = Number.parseInt(shortYearMatch[1], 10)
      year = parsed > 50 ? 1900 + parsed : 2000 + parsed
    }
  }

  // 2. Detect Make & Model
  let detectedMake = ''
  let detectedModel = ''

  for (const make of BRAZILIAN_MAKES) {
    const makeRegex = new RegExp(`\\b${make.replace('-', '[- ]?')}\\b`, 'i')
    if (makeRegex.test(text)) {
      detectedMake = make === 'Citroen' ? 'Citroën' : make === 'Mercedes' ? 'Mercedes-Benz' : make
      break
    }
  }

  // If make found, search for its specific models first
  if (detectedMake && POPULAR_MODELS[detectedMake]) {
    for (const model of POPULAR_MODELS[detectedMake]) {
      const modelRegex = new RegExp(`\\b${model.replace('-', '[- ]?')}\\b`, 'i')
      if (modelRegex.test(text)) {
        detectedModel = model
        break
      }
    }
  }

  // Fallback: search all known models
  if (!detectedModel) {
    for (const [make, models] of Object.entries(POPULAR_MODELS)) {
      for (const model of models) {
        const modelRegex = new RegExp(`\\b${model.replace('-', '[- ]?')}\\b`, 'i')
        if (modelRegex.test(text)) {
          detectedModel = model
          if (!detectedMake) detectedMake = make
          break
        }
      }
      if (detectedModel) break
    }
  }

  // 3. Detect Trim / Version
  const trims = ['Touring', 'Comfortline', 'Highline', 'Longitude', 'Limited', 'Trailhawk', 'XEi', 'Altis', 'GLi', 'EXL', 'EX', 'LX', 'Premier', 'LTZ', 'LT', 'Sport', 'Sense', 'Evolution', 'Iconic', 'Diamond', 'Prestige']
  let detectedTrim = ''
  for (const trim of trims) {
    const trimRegex = new RegExp(`\\b${trim}\\b`, 'i')
    if (trimRegex.test(text)) {
      detectedTrim = trim
      break
    }
  }
  // Check engine size e.g. 1.0, 1.4, 1.6, 2.0, 2.4, 2.8 Turbo
  const engineMatch = text.match(/\b([1-3]\.[0-9]|Turbo|TSI|T270|THP)\b/i)
  if (engineMatch && !detectedTrim.includes(engineMatch[1])) {
    detectedTrim = detectedTrim ? `${detectedTrim} ${engineMatch[1]}` : engineMatch[1]
  }

  // 4. Detect KM
  let km = 0
  const kmMatch = text.match(/\b([\d.]+)\s*(?:mil\s*)?km\b/i) || text.match(/\b([\d]+)\s*mil\s*(?:km)?\b/i)
  if (kmMatch) {
    const rawKm = kmMatch[1].replace(/\./g, '')
    const num = Number.parseInt(rawKm, 10)
    km = kmMatch[0].toLowerCase().includes('mil') && num < 1000 ? num * 1000 : num
  }

  // 5. Detect Price
  let price = 0
  const priceMatch = text.match(/(?:r\$\s*|valor:?\s*|preço:?\s*)([\d.]+)(?:,\d{2})?/i) || text.match(/\b(\d{2,3}\.?\d{3})\b/)
  if (priceMatch) {
    const rawVal = priceMatch[1].replace(/\./g, '')
    const num = Number.parseInt(rawVal, 10)
    if (num >= 5000 && num <= 2000000) {
      price = num
    }
  }

  // 6. Detect Transmission
  let transmission = 'Automático'
  if (/\bmanual\b/i.test(text)) transmission = 'Manual'
  else if (/\bcvt\b/i.test(text)) transmission = 'Automático CVT'

  // 7. Detect Fuel
  let fuelType = 'Flex'
  if (/\bdiesel\b/i.test(text)) fuelType = 'Diesel'
  else if (/\bh[íi]brido\b/i.test(text)) fuelType = 'Híbrido'
  else if (/\bel[ée]trico\b/i.test(text)) fuelType = 'Elétrico'
  else if (/\bgasolina\b/i.test(text)) fuelType = 'Gasolina'

  // 8. Detect Color
  const colors = [
    { label: 'Branco', regex: /\bbranc[oa]\b/i },
    { label: 'Preto', regex: /\bpret[oa]\b/i },
    { label: 'Prata', regex: /\bprat[ae]?(?:ado)?\b/i },
    { label: 'Cinza', regex: /\bcinza\b/i },
    { label: 'Vermelho', regex: /\bvermelh[oa]\b/i },
    { label: 'Azul', regex: /\bazul\b/i },
    { label: 'Verde', regex: /\bverde\b/i },
  ]
  let exteriorColor = 'Preto'
  for (const c of colors) {
    if (c.regex.test(text)) {
      exteriorColor = c.label
      break
    }
  }

  // 9. Location detection
  let location = 'São Paulo, SP'
  const locMatch = text.match(/\b([A-ZÀ-Ú][a-zà-ú\s]+)\s*[-/]\s*([A-Z]{2})\b/)
  if (locMatch) {
    location = `${locMatch[1].trim()}, ${locMatch[2].toUpperCase()}`
  }

  let confidence = 0.5
  if (detectedMake) confidence += 0.2
  if (detectedModel) confidence += 0.15
  if (km > 0) confidence += 0.1
  if (price > 0) confidence += 0.05

  return {
    year: year || 2022,
    make: detectedMake || 'Toyota',
    model: detectedModel || 'Corolla',
    trim: detectedTrim.trim(),
    km: km || 40000,
    price: price || 100000,
    transmission,
    fuelType,
    exteriorColor,
    location,
    description: text,
    confidence: Math.min(1.0, confidence),
  }
}

/**
 * Audits complete inventory and returns health metrics, issues, and AI recommendations.
 */
export function auditInventory(db: DatabaseSync, organizationId: number): InventoryAudit {
  const vehicles = db.prepare(`SELECT v.id, v.year, v.make, v.model, v.trim, v.price, v.km, v.status, v.description,
    (SELECT COUNT(*) FROM vehicle_images WHERE vehicle_id = v.id) imageCount
    FROM vehicles v WHERE v.organization_id = ?`).all(organizationId) as Array<{
    id: number
    year: number
    make: string
    model: string
    trim: string
    price: number
    km: number
    status: string
    description: string
    imageCount: number
  }>

  const accounts = db.prepare('SELECT id, label, status FROM social_accounts WHERE organization_id = ?')
    .all(organizationId) as Array<{ id: number; label: string; status: string }>

  const activeJobs = db.prepare(`SELECT vehicle_id FROM publication_jobs
    WHERE organization_id = ? AND status IN ('pending', 'filling', 'awaiting_confirmation')`).all(organizationId) as Array<{ vehicle_id: number }>
  const activeVehicleIds = new Set(activeJobs.map(j => j.vehicle_id))

  const total = vehicles.length
  const ready = vehicles.filter(v => v.status === 'Pronto').length
  const published = vehicles.filter(v => v.status === 'Publicado').length

  const unoptimizedDescriptions = vehicles.filter(v => !v.description || v.description.length < 50 || v.description.includes('{ano}')).length
  const missingPhotos = vehicles.filter(v => v.imageCount === 0).length
  const readyUnscheduled = vehicles.filter(v => v.status === 'Pronto' && !activeVehicleIds.has(v.id)).length

  // Calculate Health Score (0-100)
  let score = 100
  if (total === 0) score = 50
  else {
    if (unoptimizedDescriptions > 0) score -= Math.min(25, Math.round((unoptimizedDescriptions / total) * 30))
    if (missingPhotos > 0) score -= Math.min(30, Math.round((missingPhotos / total) * 40))
    if (accounts.length === 0) score -= 30
    if (readyUnscheduled > 0) score -= Math.min(15, readyUnscheduled * 3)
  }
  const healthScore = Math.max(0, Math.min(100, score))

  const recommendations: InventoryAudit['recommendations'] = []

  if (accounts.length === 0) {
    recommendations.push({
      severity: 'critical',
      title: 'Nenhum perfil de publicação associado',
      description: 'Adicione ao menos um perfil local do Brave na aba "Equipe e contas" para habilitar as publicações.',
      actionText: 'Associar Perfil',
      actionIntent: 'navigate_team',
    })
  }

  if (readyUnscheduled > 0) {
    recommendations.push({
      severity: 'warning',
      title: `${readyUnscheduled} veículo${readyUnscheduled === 1 ? '' : 's'} pronto${readyUnscheduled === 1 ? '' : 's'} fora da fila`,
      description: 'Veículos marcados como "Pronto" estão parados sem agendamento nas melhores janelas de tráfego.',
      actionText: 'Executar Piloto Automático',
      actionIntent: 'run_autopilot',
    })
  }

  if (unoptimizedDescriptions > 0) {
    recommendations.push({
      severity: 'info',
      title: `${unoptimizedDescriptions} veículo${unoptimizedDescriptions === 1 ? '' : 's'} com descrição padrão ou curta`,
      description: 'Descrições enriquecidas com IA aumentam o engajamento no Marketplace em até 3,4x.',
      actionText: 'Otimizar com IA',
      actionIntent: 'optimize_descriptions',
    })
  }

  if (missingPhotos > 0) {
    recommendations.push({
      severity: 'warning',
      title: `${missingPhotos} veículo${missingPhotos === 1 ? '' : 's'} sem fotos cadastradas`,
      description: 'O Facebook Marketplace não permite publicação de veículos sem pelo menos uma foto de capa.',
      actionText: 'Ver Veículos',
      actionIntent: 'navigate_vehicles',
    })
  }

  const optimalSchedule = calculateOptimalSchedule()

  return {
    healthScore,
    totalVehicles: total,
    readyVehicles: ready,
    publishedVehicles: published,
    unoptimizedDescriptions,
    missingPhotos,
    readyUnscheduled,
    activeAccounts: accounts.length,
    peakWindowAvailable: optimalSchedule.window,
    recommendations,
  }
}

/**
 * Autopilot: Automatically enriches unoptimized descriptions, selects ready vehicles,
 * pairs them with best available accounts and schedules them in peak automotive hours.
 */
export async function runAutopilotPipeline(db: DatabaseSync, organizationId: number, userId: number): Promise<AutopilotResult> {
  // 1. Fetch available accounts
  const accounts = db.prepare('SELECT id, label, browser_profile browserProfile, status FROM social_accounts WHERE organization_id = ?')
    .all(organizationId) as Array<{ id: number; label: string; browserProfile: string; status: string }>

  if (!accounts.length) {
    return {
      ok: false,
      processedCount: 0,
      jobsCreated: 0,
      descriptionsOptimized: 0,
      assignments: [],
      message: 'Não há perfis de publicação cadastrados. Associe um perfil do Brave antes de rodar o piloto automático.',
    }
  }

  // 2. Fetch ready vehicles not in active jobs
  const vehicles = db.prepare(`SELECT v.id, v.year, v.make, v.model, v.trim, v.price, v.km, v.status, v.description,
    v.exterior_color exteriorColor, v.transmission, v.fuel_type fuelType, v.vehicle_condition condition, v.location,
    (SELECT COUNT(*) FROM vehicle_images WHERE vehicle_id = v.id) imageCount
    FROM vehicles v
    WHERE v.organization_id = ? AND v.status = 'Pronto'
      AND v.id NOT IN (
        SELECT vehicle_id FROM publication_jobs
        WHERE organization_id = ? AND status IN ('pending', 'filling', 'awaiting_confirmation')
      )`).all(organizationId, organizationId) as Array<{
    id: number
    year: number
    make: string
    model: string
    trim: string
    price: number
    km: number
    status: string
    description: string
    exteriorColor: string
    transmission: string
    fuelType: string
    condition: string
    location: string
    imageCount: number
  }>

  if (!vehicles.length) {
    return {
      ok: true,
      processedCount: 0,
      jobsCreated: 0,
      descriptionsOptimized: 0,
      assignments: [],
      message: 'Todos os veículos prontos já estão agendados ou em publicação.',
    }
  }

  const assignments: AutopilotResult['assignments'] = []
  let descriptionsOptimized = 0

  // Existing upcoming jobs to avoid schedule collision
  const existingJobs = db.prepare(`SELECT social_account_id accountId, scheduled_at scheduledAt FROM publication_jobs
    WHERE organization_id = ? AND scheduled_at IS NOT NULL AND datetime(scheduled_at) > CURRENT_TIMESTAMP
    AND status IN ('pending', 'filling', 'awaiting_confirmation')`).all(organizationId) as Array<{ accountId: number; scheduledAt: string }>

  const accountSchedules = new Map<number, number[]>()
  for (const item of existingJobs) {
    const ts = Date.parse(item.scheduledAt)
    if (Number.isFinite(ts)) {
      accountSchedules.set(item.accountId, [...(accountSchedules.get(item.accountId) || []), ts])
    }
  }

  const aiConf = db.prepare('SELECT gemini_api_key geminiApiKey, openai_api_key openaiApiKey, ai_provider aiProvider FROM organization_settings WHERE organization_id = ?')
    .get(organizationId) as { geminiApiKey?: string; openaiApiKey?: string; aiProvider?: 'auto' | 'gemini' | 'openai' } | undefined
  const provider = aiConf?.aiProvider || 'auto'
  const apiKey = provider === 'gemini' ? (aiConf?.geminiApiKey || process.env.GEMINI_API_KEY) : (aiConf?.openaiApiKey || process.env.OPENAI_API_KEY)

  db.exec('BEGIN')
  try {
    for (const vehicle of vehicles) {
      // Step A: Optimize description if weak
      if (!vehicle.description || vehicle.description.length < 60 || vehicle.description.includes('{ano}')) {
        const input: VehicleInput = {
          year: vehicle.year,
          make: vehicle.make,
          model: vehicle.model,
          trim: vehicle.trim,
          km: vehicle.km,
          price: vehicle.price,
          exteriorColor: vehicle.exteriorColor,
          transmission: vehicle.transmission,
          fuelType: vehicle.fuelType,
          condition: vehicle.condition,
          location: vehicle.location,
        }
        const generated = await generateVehicleDescription(input, { tone: 'vendedor', provider, apiKey })
        const tags = generateVehicleHashtags(input)
        const fullDesc = `${generated.description}\n\n${tags.join(' ')}`
        db.prepare('UPDATE vehicles SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?')
          .run(fullDesc, vehicle.id, organizationId)
        descriptionsOptimized++
      }

      // Step B: Match best account
      const best = findBestAccountForVehicle(db, organizationId, vehicle.id)
      const targetAccountId = best ? best.id : accounts[0].id
      const targetAccountLabel = best ? best.label : accounts[0].label

      // Step C: Calculate optimal schedule
      const existingTimestamps = accountSchedules.get(targetAccountId) || []
      const optimal = calculateOptimalSchedule({ existingTimestamps, accountId: targetAccountId })
      accountSchedules.set(targetAccountId, [...existingTimestamps, optimal.scheduledAt.getTime()])

      // Step D: Insert into publication jobs
      const priorityRow = db.prepare(`SELECT COALESCE(MAX(queue_priority), 0) + 1 val FROM publication_jobs
        WHERE organization_id = ? AND social_account_id = ? AND status IN ('pending', 'filling', 'awaiting_confirmation')`)
        .get(organizationId, targetAccountId) as { val: number }

      const insert = db.prepare(`INSERT INTO publication_jobs (
        organization_id, vehicle_id, social_account_id, status, scheduled_at, queue_priority, retry_count, max_retries
      ) VALUES (?, ?, ?, 'pending', ?, ?, 0, 3)`).run(organizationId, vehicle.id, targetAccountId, optimal.isoString, priorityRow.val)

      const jobId = Number(insert.lastInsertRowid)

      // Record event
      db.prepare(`INSERT INTO publication_job_events (organization_id, publication_job_id, created_by, event_type, details)
        VALUES (?, ?, ?, 'autopilot_scheduled', ?)`).run(
        organizationId,
        jobId,
        userId,
        JSON.stringify({ scheduledAt: optimal.isoString, window: optimal.window, automated: true })
      )

      assignments.push({
        vehicleId: vehicle.id,
        title: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
        accountId: targetAccountId,
        accountLabel: targetAccountLabel,
        scheduledAt: optimal.isoString,
        window: optimal.window,
      })
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return {
    ok: true,
    processedCount: vehicles.length,
    jobsCreated: assignments.length,
    descriptionsOptimized,
    assignments,
    message: `${assignments.length} veículo${assignments.length === 1 ? '' : 's'} agendado${assignments.length === 1 ? '' : 's'} com sucesso nos horários de pico.`,
  }
}

/**
 * Optimizes descriptions for all vehicles in inventory that have weak or missing text.
 */
export async function batchOptimizeDescriptions(db: DatabaseSync, organizationId: number, tone: CopyTone = 'vendedor') {
  const vehicles = db.prepare(`SELECT id, year, make, model, trim, price, km, description,
    exterior_color exteriorColor, transmission, fuel_type fuelType, vehicle_condition condition, location
    FROM vehicles WHERE organization_id = ?`).all(organizationId) as Array<{
    id: number
    year: number
    make: string
    model: string
    trim: string
    price: number
    km: number
    description: string
    exteriorColor: string
    transmission: string
    fuelType: string
    condition: string
    location: string
  }>

  const aiConf = db.prepare('SELECT gemini_api_key geminiApiKey, openai_api_key openaiApiKey, ai_provider aiProvider FROM organization_settings WHERE organization_id = ?')
    .get(organizationId) as { geminiApiKey?: string; openaiApiKey?: string; aiProvider?: 'auto' | 'gemini' | 'openai' } | undefined
  const provider = aiConf?.aiProvider || 'auto'
  const apiKey = provider === 'gemini' ? (aiConf?.geminiApiKey || process.env.GEMINI_API_KEY) : (aiConf?.openaiApiKey || process.env.OPENAI_API_KEY)

  let updated = 0
  for (const v of vehicles) {
    if (!v.description || v.description.length < 60 || v.description.includes('{ano}')) {
      const input: VehicleInput = {
        year: v.year,
        make: v.make,
        model: v.model,
        trim: v.trim,
        km: v.km,
        price: v.price,
        exteriorColor: v.exteriorColor,
        transmission: v.transmission,
        fuelType: v.fuelType,
        condition: v.condition,
        location: v.location,
      }
      const generated = await generateVehicleDescription(input, { tone, provider, apiKey })
      const tags = generateVehicleHashtags(input)
      const fullDesc = `${generated.description}\n\n${tags.join(' ')}`
      db.prepare('UPDATE vehicles SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?')
        .run(fullDesc, v.id, organizationId)
      updated++
    }
  }
  return { ok: true, updated }
}

/**
 * Natural language command dispatcher for conversational operations.
 */
export async function executeAgentCommand(db: DatabaseSync, organizationId: number, userId: number, prompt: string): Promise<AgentCommandResult> {
  const p = prompt.toLowerCase().trim()

  // Intent 1: Autopilot / Schedule
  if (p.includes('agendar') || p.includes('publicar') || p.includes('piloto') || p.includes('autopilot') || p.includes('fila')) {
    const result = await runAutopilotPipeline(db, organizationId, userId)
    return {
      ok: true,
      intent: 'autopilot',
      reply: result.message,
      actionTaken: 'run_autopilot',
      details: result,
    }
  }

  // Intent 2: Optimize Descriptions
  if (p.includes('otimiz') || p.includes('descriç') || p.includes('texto') || p.includes('copy') || p.includes('hashtag')) {
    let tone: CopyTone = 'vendedor'
    if (p.includes('profissional')) tone = 'profissional'
    if (p.includes('amig') || p.includes('amigável')) tone = 'amigável'
    if (p.includes('direto')) tone = 'direto'

    const result = await batchOptimizeDescriptions(db, organizationId, tone)
    return {
      ok: true,
      intent: 'optimize_descriptions',
      reply: `${result.updated} descrição(ões) de veículos foram geradas e enriquecidas com IA no tom "${tone}".`,
      actionTaken: 'batch_optimize',
      details: result,
    }
  }

  // Intent 3: Audit Inventory
  if (p.includes('audit') || p.includes('saúde') || p.includes('diagnóst') || p.includes('status') || p.includes('estoque')) {
    const audit = auditInventory(db, organizationId)
    return {
      ok: true,
      intent: 'audit',
      reply: `Saúde operacional do estoque: ${audit.healthScore}%. Há ${audit.readyVehicles} veículos prontos (${audit.readyUnscheduled} fora da fila) e ${audit.unoptimizedDescriptions} veículos precisando de copy com IA.`,
      actionTaken: 'audit_inventory',
      details: audit,
    }
  }

  // Intent 4: Curate Groups
  if (p.includes('grupo') || p.includes('curador') || p.includes('reordenar')) {
    const rawGroups = db.prepare(`SELECT id, name, url, group_key groupKey, active, priority, success_count successCount, failure_count failureCount, last_found_at lastFoundAt
      FROM marketplace_groups WHERE organization_id = ? ORDER BY priority, id`).all(organizationId) as Array<{
      id: number; name: string; url: string; groupKey: string; active: number; priority: number; successCount: number; failureCount: number; lastFoundAt?: string
    }>
    const curated = curateMarketplaceGroups(rawGroups.map(g => ({ ...g, active: Boolean(g.active) })), '', 10)
    db.exec('BEGIN')
    try {
      for (let i = 0; i < curated.length; i++) {
        const item = curated[i]
        db.prepare('UPDATE marketplace_groups SET priority = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?')
          .run(i + 1, item.recommendedActive ? 1 : 0, item.group.id, organizationId)
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return {
      ok: true,
      intent: 'curate_groups',
      reply: `${curated.length} grupos do Marketplace foram pontuados e reordenados por confiabilidade e taxa de conversão.`,
      actionTaken: 'curate_groups',
      details: { count: curated.length },
    }
  }

  // Default Fallback
  return {
    ok: true,
    intent: 'general_assistance',
    reply: `Comando compreendido. Você pode me pedir para:
1. "Executar piloto automático no estoque pronto"
2. "Otimizar descrições dos veículos com IA"
3. "Auditar saúde do estoque e identificar pendências"
4. "Reordenar grupos do Marketplace por conversão"`,
    actionTaken: 'help',
  }
}
