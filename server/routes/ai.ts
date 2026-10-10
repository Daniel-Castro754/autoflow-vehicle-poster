import { getAiCredentials } from '../services/credential-vault.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import {
  auditInventory,
  executeAgentCommand,
  parseVehicleRawText,
  runAutopilotPipeline,
} from '../services/ai-agent.ts'
import {
  generateVehicleDescription,
  resolveAIProviderSettings,
  type CopyTone,
  type VehicleInput,
} from '../services/description-generator.ts'
import { generateVehicleHashtags } from '../services/trending-hashtags.ts'
import { getAiAuditHistory, recordAiAudit } from '../services/ai-audit-history.ts'
import {
  applyBatchDescriptionPreview,
  consumeAutopilotPreview,
  prepareAutopilotPreview,
  prepareBatchDescriptionPreview,
} from '../services/ai-operation-previews.ts'

type AuthContext = { userId: number; organizationId: number }
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage) => Promise<unknown>
  isAdmin: (auth: AuthContext) => boolean
}

export async function handleAIRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: AuthContext,
  { db, send, jsonBody, isAdmin }: Dependencies,
): Promise<boolean> {
  if (url.pathname.startsWith('/api/ai/') && !isAdmin(auth)) {
    send(res, 403, { error: 'Somente administradores podem operar a Central de IA.' })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/generate-description') {
    const b = (await jsonBody(req)) as Record<string, unknown>
    const vehicle = (b.vehicle || b) as Record<string, unknown>
    const input: VehicleInput = {
      year: Number(vehicle.year) || new Date().getFullYear(),
      make: String(vehicle.make || '').trim(),
      model: String(vehicle.model || '').trim(),
      trim: String(vehicle.trim || vehicle.version || '').trim(),
      km: Number(vehicle.km) || 0,
      price: Number(vehicle.price) || 0,
      transmission: String(vehicle.transmission || 'Automático'),
      fuelType: String(vehicle.fuelType || vehicle.fuel || 'Flex'),
      bodyType: String(vehicle.bodyType || 'Sedã'),
      exteriorColor: String(vehicle.exteriorColor || vehicle.color || ''),
      interiorColor: String(vehicle.interiorColor || ''),
      condition: String(vehicle.condition || 'Muito bom'),
      location: String(vehicle.location || 'São Paulo, SP'),
    }
    if (!input.make || !input.model) {
      send(res, 400, { error: 'Marca e modelo do veículo são obrigatórios.' })
      return true
    }
    const tone = String(b.tone || 'vendedor') as CopyTone
    const aiConf = getAiCredentials(db, auth.organizationId)
    const result = await generateVehicleDescription(input, {
      tone,
      ...resolveAIProviderSettings(aiConf),
    })
    const hashtags = generateVehicleHashtags(input)
    recordAiAudit(
      db,
      auth.organizationId,
      auth.userId,
      'description_generated',
      'applied',
      result.provider,
      1,
    )
    send(res, 200, {
      ok: true,
      description: result.description,
      provider: result.provider,
      fallbackReason: result.fallbackReason || null,
      attemptedProviders: result.attemptedProviders || [],
      hashtags,
    })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/parse-text') {
    const b = (await jsonBody(req)) as Record<string, unknown>
    const rawText = String(b.text || b.rawText || '').trim()
    if (!rawText) {
      send(res, 400, { error: 'O texto para análise não pode estar vazio.' })
      return true
    }
    send(res, 200, { ok: true, vehicle: parseVehicleRawText(rawText) })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/ai/history') {
    send(res, 200, { ok: true, history: getAiAuditHistory(db, auth.organizationId) })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/ai/provider-status') {
    const stored = db
      .prepare(
        'SELECT gemini_api_key gemini,openai_api_key openai,ai_provider preference FROM organization_settings WHERE organization_id=?',
      )
      .get(auth.organizationId) as
      { gemini: string; openai: string; preference: string } | undefined
    send(res, 200, {
      ok: true,
      preference: stored?.preference || 'auto',
      geminiConfigured: Boolean(stored?.gemini || process.env.GEMINI_API_KEY),
      openaiConfigured: Boolean(stored?.openai || process.env.OPENAI_API_KEY),
      fallback: 'procedural',
    })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/ai/audit') {
    send(res, 200, { ok: true, audit: auditInventory(db, auth.organizationId) })
    return true
  }
  if (req.method === 'GET' && url.pathname === '/api/ai/autopilot/preview') {
    const preview = prepareAutopilotPreview(db, auth.organizationId, auth.userId)
    recordAiAudit(
      db,
      auth.organizationId,
      auth.userId,
      'manual_pilot_preview',
      'preview',
      null,
      preview.potentialVehicles.length,
    )
    send(res, 200, preview)
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/autopilot/run') {
    const body = (await jsonBody(req)) as Record<string, unknown>
    if (typeof body.previewId !== 'string') {
      send(res, 428, { error: 'Confira e confirme a prévia do piloto antes de agendar.' })
      return true
    }
    try {
      consumeAutopilotPreview(db, auth.organizationId, auth.userId, body.previewId)
    } catch (err) {
      send(res, 409, { error: err instanceof Error ? err.message : 'Prévia inválida.' })
      return true
    }
    const result = await runAutopilotPipeline(db, auth.organizationId, auth.userId)
    recordAiAudit(
      db,
      auth.organizationId,
      auth.userId,
      'manual_pilot_executed',
      result.ok ? 'applied' : 'rejected',
      null,
      result.jobsCreated,
    )
    send(res, 200, result)
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/command') {
    const b = (await jsonBody(req)) as Record<string, unknown>
    const prompt = String(b.prompt || b.command || '').trim()
    if (!prompt) {
      send(res, 400, { error: 'O comando não pode estar vazio.' })
      return true
    }
    const result = await executeAgentCommand(db, auth.organizationId, auth.userId, prompt)
    recordAiAudit(db, auth.organizationId, auth.userId, 'assistant_command', 'preview')
    send(res, 200, result)
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/batch-optimize/preview') {
    const b = (await jsonBody(req)) as Record<string, unknown>
    try {
      const preview = await prepareBatchDescriptionPreview(
        db,
        auth.organizationId,
        auth.userId,
        String(b.tone || 'vendedor') as CopyTone,
      )
      recordAiAudit(
        db,
        auth.organizationId,
        auth.userId,
        'description_preview',
        'preview',
        null,
        preview.proposals.length,
      )
      send(res, 200, preview)
    } catch (err) {
      send(res, 400, {
        error: err instanceof Error ? err.message : 'Não foi possível gerar a prévia.',
      })
    }
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/batch-optimize') {
    const b = (await jsonBody(req)) as Record<string, unknown>
    if (typeof b.previewId !== 'string' || !Array.isArray(b.selectedVehicleIds)) {
      send(res, 428, { error: 'Revise os textos e selecione quais descrições deseja aplicar.' })
      return true
    }
    try {
      const result = applyBatchDescriptionPreview(
        db,
        auth.organizationId,
        auth.userId,
        b.previewId,
        b.selectedVehicleIds,
      )
      recordAiAudit(
        db,
        auth.organizationId,
        auth.userId,
        'description_approved',
        'applied',
        null,
        result.updated,
      )
      send(res, 200, result)
    } catch (err) {
      send(res, 409, { error: err instanceof Error ? err.message : 'Prévia inválida.' })
    }
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/ai/test-key') {
    const b = (await jsonBody(req)) as Record<string, unknown>
    const provider = String(b.provider || 'gemini').toLowerCase()
    const settings = getAiCredentials(db, auth.organizationId)
    const key =
      String(b.apiKey || '').trim() ||
      (provider === 'gemini'
        ? settings?.geminiApiKey || process.env.GEMINI_API_KEY
        : settings?.openaiApiKey || process.env.OPENAI_API_KEY) ||
      ''
    if (!key) {
      send(res, 400, { error: 'Informe a chave de API para testar.' })
      return true
    }
    if (provider === 'gemini') {
      try {
        const response = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              contents: [{ parts: [{ text: 'ping' }] }],
              generationConfig: { maxOutputTokens: 5 },
            }),
          },
        )
        if (!response.ok) {
          const errData = (await response.json().catch(() => ({}))) as {
            error?: { message?: string }
          }
          send(res, 400, {
            ok: false,
            error:
              errData.error?.message ||
              `Erro ${response.status} ao conectar com a API do Google Gemini.`,
          })
          return true
        }
        recordAiAudit(db, auth.organizationId, auth.userId, 'api_key_test', 'tested', 'gemini')
        send(res, 200, {
          ok: true,
          message: '✓ Chave do Google Gemini validada com sucesso! Conexão estabelecida.',
        })
        return true
      } catch (err) {
        send(res, 500, {
          ok: false,
          error: `Falha de rede ao conectar com Google Gemini: ${err instanceof Error ? err.message : err}`,
        })
        return true
      }
    }
    if (provider === 'openai') {
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        })
        if (!response.ok) {
          send(res, 400, { ok: false, error: `Chave OpenAI inválida (status ${response.status}).` })
          return true
        }
        recordAiAudit(db, auth.organizationId, auth.userId, 'api_key_test', 'tested', 'openai')
        send(res, 200, { ok: true, message: '✓ Chave OpenAI validada com sucesso!' })
        return true
      } catch (err) {
        send(res, 500, {
          ok: false,
          error: `Falha de rede com OpenAI: ${err instanceof Error ? err.message : err}`,
        })
        return true
      }
    }
    send(res, 400, { error: 'Provedor desconhecido.' })
    return true
  }
  return false
}
