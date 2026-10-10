import React, { useState, useEffect, useCallback } from 'react'
import {
  Sparkles,
  Bot,
  Check,
  CircleAlert,
  RotateCcw,
  Clock,
  Gauge,
  Zap,
  Send,
  FileText,
  CheckCircle2,
  Copy,
  Plus,
  Car,
} from 'lucide-react'
import type { VehicleRecord } from './Vehicles'
import {
  BODY_TYPES,
  FUEL_TYPES,
  TRANSMISSIONS,
  VEHICLE_COLORS,
  VEHICLE_CONDITIONS,
  VEHICLE_MAKES,
  VEHICLE_TYPES,
} from './vehicleOptions'

type ApiFn = <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>

interface InventoryAudit {
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

interface ParsedVehicle {
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
  vehicleType: string
  bodyType: string
  condition: string
  interiorColor: string
}

interface AutopilotResult {
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

interface DescriptionPreview {
  previewId: string | null
  totalEligible: number
  remainingAfterBatch: number
  proposals: Array<{
    vehicleId: number
    label: string
    original: string
    proposed: string
    provider: string
    fallbackReason?: string
  }>
}

interface AiOperationEvent {
  id: number
  action: string
  outcome: string
  provider: string | null
  items: number
  createdAt: string
}

interface AiProviderStatus {
  preference: string
  geminiConfigured: boolean
  openaiConfigured: boolean
  fallback: string
}

interface CommandLog {
  id: string
  timestamp: string
  prompt: string
  reply: string
  actionTaken?: string
}

const money = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

export function AiCenterView({
  api,
  vehicles,
  reloadVehicles,
  navigate,
}: {
  api: ApiFn
  vehicles: VehicleRecord[]
  reloadVehicles: () => Promise<void>
  navigate: (page: string) => void
}) {
  const [audit, setAudit] = useState<InventoryAudit | null>(null)
  const [aiHistory, setAiHistory] = useState<AiOperationEvent[]>([])
  const [providerStatus, setProviderStatus] = useState<AiProviderStatus | null>(null)
  const [loadingAudit, setLoadingAudit] = useState(true)
  const [runningAutopilot, setRunningAutopilot] = useState(false)
  const [autopilotResult, setAutopilotResult] = useState<AutopilotResult | null>(null)

  // Command Console state
  const [commandText, setCommandText] = useState('')
  const [commandLoading, setCommandLoading] = useState(false)
  const [commandLogs, setCommandLogs] = useState<CommandLog[]>([
    {
      id: 'welcome',
      timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      prompt: 'Iniciar Assistente Autônomo',
      reply:
        'Olá! Sou o agente de operações de IA do AutoFlow. Posso ler anúncios crus, auditar estoque, otimizar textos em lote e agendar publicações nos horários de pico.',
      actionTaken: 'ready',
    },
  ])

  // Smart Reader state
  const [rawText, setRawText] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parsedVehicle, setParsedVehicle] = useState<ParsedVehicle | null>(null)
  const [savingParsed, setSavingParsed] = useState(false)
  const [parseMessage, setParseMessage] = useState('')

  // Batch optimize state
  const [optimizingBatch, setOptimizingBatch] = useState(false)
  const [descriptionPreview, setDescriptionPreview] = useState<DescriptionPreview | null>(null)
  const [approvedDescriptionIds, setApprovedDescriptionIds] = useState<number[]>([])
  const [message, setMessage] = useState('')
  const [auditError, setAuditError] = useState(false)

  const loadAudit = useCallback(async () => {
    try {
      const res = await api<{ ok: boolean; audit: InventoryAudit }>('/ai/audit')
      if (res.ok) {
        setAudit(res.audit)
        setAuditError(false)
      } else setAuditError(true)
    } catch {
      setAuditError(true)
    } finally {
      setLoadingAudit(false)
    }
  }, [api])

  useEffect(() => {
    let active = true
    api<{ ok: boolean; audit: InventoryAudit }>('/ai/audit')
      .then((res) => {
        if (!active) return
        if (res.ok) {
          setAudit(res.audit)
          setAuditError(false)
        } else setAuditError(true)
      })
      .catch(() => {
        if (active) setAuditError(true)
      })
      .finally(() => {
        if (active) setLoadingAudit(false)
      })
    return () => {
      active = false
    }
  }, [api])

  async function refreshAiHistory() {
    try {
      const [log, provider] = await Promise.all([
        api<{ history: AiOperationEvent[] }>('/ai/history'),
        api<AiProviderStatus>('/ai/provider-status'),
      ])
      setAiHistory(log.history)
      setProviderStatus(provider)
    } catch {
      // History is informational and must not block operations.
    }
  }

  useEffect(() => {
    let active = true
    Promise.all([
      api<{ history: AiOperationEvent[] }>('/ai/history'),
      api<AiProviderStatus>('/ai/provider-status'),
    ])
      .then(([log, status]) => {
        if (active) {
          setAiHistory(log.history)
          setProviderStatus(status)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [api])

  async function handleRunAutopilot() {
    setRunningAutopilot(true)
    setAutopilotResult(null)
    try {
      const preview = await api<{
        previewId: string | null
        connectedProfiles: number
        potentialVehicles: Array<{ id: number; title: string }>
        note: string
      }>('/ai/autopilot/preview')
      if (!preview.previewId) {
        setMessage('Nenhum veículo e perfil conectados disponíveis para a prévia de agendamento.')
        return
      }
      const list = preview.potentialVehicles.slice(0, 8).map((v) => v.title + ' (#' + v.id + ')')
      if (
        !window.confirm(
          [
            'PRÉVIA DO PILOTO AUTOMÁTICO — ainda não foi agendado nenhum veículo.',
            'Perfis conectados: ' + preview.connectedProfiles,
            'Candidatos: ' + preview.potentialVehicles.length,
            ...list,
            preview.potentialVehicles.length > 8 ? '(e outros veículos)' : '',
            preview.note,
            'Confirmar a criação dos agendamentos?',
          ]
            .filter(Boolean)
            .join('\n'),
        )
      ) {
        setMessage('Piloto cancelado sem alterações.')
        return
      }
      const res = await api<AutopilotResult>('/ai/autopilot/run', {
        method: 'POST',
        body: JSON.stringify({ previewId: preview.previewId }),
      })
      setAutopilotResult(res)
      setMessage(res.message)
      await refreshAiHistory()
      await loadAudit()
      await reloadVehicles()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Erro ao executar piloto automático.')
    } finally {
      setRunningAutopilot(false)
    }
  }

  async function handleSendCommand(customPrompt?: string) {
    const text = (customPrompt || commandText).trim()
    if (!text) return
    setCommandLoading(true)
    setCommandText('')

    try {
      const res = await api<{ ok: boolean; intent: string; reply: string; actionTaken?: string }>(
        '/ai/command',
        {
          method: 'POST',
          body: JSON.stringify({ prompt: text }),
        },
      )
      const logEntry: CommandLog = {
        id: String(Date.now()),
        timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        prompt: text,
        reply: res.reply,
        ...(res.actionTaken === undefined ? {} : { actionTaken: res.actionTaken }),
      }
      setCommandLogs((prev) => [logEntry, ...prev])
      await refreshAiHistory()
      await loadAudit()
      await reloadVehicles()
    } catch (err) {
      const errEntry: CommandLog = {
        id: String(Date.now()),
        timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        prompt: text,
        reply: `Erro ao processar: ${err instanceof Error ? err.message : 'Falha na comunicação.'}`,
      }
      setCommandLogs((prev) => [errEntry, ...prev])
    } finally {
      setCommandLoading(false)
    }
  }

  async function handleParseRawText(e: React.FormEvent) {
    e.preventDefault()
    if (!rawText.trim()) return
    setParsing(true)
    setParseMessage('')
    setParsedVehicle(null)

    try {
      const res = await api<{
        ok: boolean
        vehicle: Omit<ParsedVehicle, 'vehicleType' | 'bodyType' | 'condition' | 'interiorColor'>
      }>('/ai/parse-text', {
        method: 'POST',
        body: JSON.stringify({ text: rawText }),
      })
      if (res.ok) {
        setParsedVehicle({
          ...res.vehicle,
          exteriorColor: VEHICLE_COLORS.includes(
            res.vehicle.exteriorColor as (typeof VEHICLE_COLORS)[number],
          )
            ? res.vehicle.exteriorColor
            : '',
          vehicleType: '',
          bodyType: '',
          condition: '',
          interiorColor: '',
        })
        setParseMessage(
          `Veículo extraído com ${Math.round(res.vehicle.confidence * 100)}% de confiança.`,
        )
      }
    } catch (err) {
      setParseMessage(err instanceof Error ? err.message : 'Erro ao processar texto.')
    } finally {
      setParsing(false)
    }
  }

  const canSaveParsedVehicle = Boolean(
    parsedVehicle &&
    parsedVehicle.year >= 1900 &&
    parsedVehicle.year <= new Date().getFullYear() + 1 &&
    VEHICLE_MAKES.includes(parsedVehicle.make as (typeof VEHICLE_MAKES)[number]) &&
    parsedVehicle.model.trim() &&
    parsedVehicle.price > 0 &&
    parsedVehicle.location.trim() &&
    parsedVehicle.description.trim() &&
    parsedVehicle.vehicleType &&
    parsedVehicle.bodyType &&
    parsedVehicle.condition &&
    parsedVehicle.transmission &&
    parsedVehicle.fuelType &&
    parsedVehicle.exteriorColor &&
    parsedVehicle.interiorColor,
  )

  async function handleSaveParsedToStock() {
    if (!parsedVehicle || !canSaveParsedVehicle) return
    setSavingParsed(true)
    try {
      await api('/vehicles', {
        method: 'POST',
        body: JSON.stringify({
          year: parsedVehicle.year,
          make: parsedVehicle.make,
          model: parsedVehicle.model,
          trim: parsedVehicle.trim,
          km: parsedVehicle.km,
          price: parsedVehicle.price,
          status: 'Rascunho',
          color: '#dce8ef',
          vehicleType: parsedVehicle.vehicleType,
          bodyType: parsedVehicle.bodyType,
          condition: parsedVehicle.condition,
          location: parsedVehicle.location,
          description: parsedVehicle.description,
          transmission: parsedVehicle.transmission,
          fuelType: parsedVehicle.fuelType,
          exteriorColor: parsedVehicle.exteriorColor,
          interiorColor: parsedVehicle.interiorColor,
        }),
      })
      setParseMessage('✓ Veículo cadastrado com sucesso no estoque!')
      setParsedVehicle(null)
      setRawText('')
      await reloadVehicles()
      await loadAudit()
    } catch (err) {
      setParseMessage(err instanceof Error ? err.message : 'Erro ao salvar veículo no estoque.')
    } finally {
      setSavingParsed(false)
    }
  }

  async function handleBatchOptimize() {
    setOptimizingBatch(true)
    setDescriptionPreview(null)
    setApprovedDescriptionIds([])
    try {
      const preview = await api<DescriptionPreview>('/ai/batch-optimize/preview', {
        method: 'POST',
        body: JSON.stringify({ tone: 'vendedor' }),
      })
      setDescriptionPreview(preview)
      await refreshAiHistory()
      setMessage(
        preview.proposals.length
          ? 'Compare os textos e selecione os veículos que deseja atualizar. Nenhum texto foi salvo.'
          : 'Não há descrições elegíveis para esta rodada.',
      )
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Erro ao gerar propostas de descrição.')
    } finally {
      setOptimizingBatch(false)
    }
  }

  async function handleApplyDescriptions() {
    if (!descriptionPreview?.previewId || !approvedDescriptionIds.length) return
    if (
      !window.confirm(
        'Aplicar ' +
          approvedDescriptionIds.length +
          ' descrição(ões) revisada(s)? Esta ação modifica o cadastro dos veículos selecionados.',
      )
    )
      return
    setOptimizingBatch(true)
    try {
      const result = await api<{ ok: boolean; updated: number }>('/ai/batch-optimize', {
        method: 'POST',
        body: JSON.stringify({
          previewId: descriptionPreview.previewId,
          selectedVehicleIds: approvedDescriptionIds,
        }),
      })
      setMessage(result.updated + ' descrição(ões) atualizada(s) após aprovação.')
      await refreshAiHistory()
      setDescriptionPreview(null)
      setApprovedDescriptionIds([])
      await reloadVehicles()
      await loadAudit()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao aplicar descrições.')
    } finally {
      setOptimizingBatch(false)
    }
  }

  return (
    <section className="content ai-center-page">
      <div className="title-row">
        <div>
          <span className="page-kicker">OPERAÇÕES AUTÔNOMAS</span>
          <h1>Central de IA</h1>
          <p>Leitura de anúncios, piloto automático de publicações e orquestração inteligente.</p>
        </div>
        <div className="title-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => void loadAudit()}
            disabled={loadingAudit}
          >
            <RotateCcw size={16} />
            {loadingAudit ? 'Consultando...' : 'Atualizar diagnóstico'}
          </button>
        </div>
      </div>

      {message && (
        <div className="inline-message success">
          <CheckCircle2 size={16} />
          {message}
          <button onClick={() => setMessage('')}>×</button>
        </div>
      )}

      <div className="ai-workflow-intro">
        <div>
          <span className="page-kicker">FLUXO DE TRABALHO</span>
          <h2>Prepare, agende e acompanhe</h2>
          <p>
            Confira os requisitos do estoque antes de iniciar a automação. A publicação respeita as
            configurações e confirmações existentes.
          </p>
        </div>
        <div className="ai-workflow-steps" aria-label="Etapas do fluxo">
          <span>
            <strong>01</strong> Preparar
          </span>
          <span>
            <strong>02</strong> Agendar
          </span>
          <span>
            <strong>03</strong> Acompanhar
          </span>
        </div>
      </div>
      {auditError && (
        <p className="ai-audit-warning" role="status">
          Não foi possível atualizar o diagnóstico do estoque. Confira a conexão com o servidor
          antes de iniciar o piloto.
        </p>
      )}
      {/* KPI Cards */}
      <div className="ai-kpi-grid">
        <article className="ai-kpi-card">
          <div className="ai-kpi-head">
            <span className="ai-kpi-label">Saúde do Estoque</span>
            <Gauge size={20} className="ai-icon-green" />
          </div>
          <div className="ai-kpi-val">
            <strong>{audit ? `${audit.healthScore}%` : '—'}</strong>
            {audit && (
              <span className={`ai-badge ${audit.healthScore >= 80 ? 'good' : 'warning'}`}>
                {audit.healthScore >= 80 ? 'Em dia' : 'Requer atenção'}
              </span>
            )}
          </div>
          <small>{audit?.totalVehicles ?? vehicles.length} veículos cadastrados na base</small>
        </article>

        <article className="ai-kpi-card">
          <div className="ai-kpi-head">
            <span className="ai-kpi-label">Prontos p/ Publicação</span>
            <Check size={20} className="ai-icon-blue" />
          </div>
          <div className="ai-kpi-val">
            <strong>
              {audit?.readyVehicles ?? vehicles.filter((v) => v.status === 'Pronto').length}
            </strong>
            <span className="ai-sub-info">
              {audit ? `${audit.readyUnscheduled} fora da fila` : 'Verificar fila'}
            </span>
          </div>
          <small>Prontos para envio autônomo</small>
        </article>

        <article className="ai-kpi-card">
          <div className="ai-kpi-head">
            <span className="ai-kpi-label">Janela sugerida</span>
            <Clock size={20} className="ai-icon-purple" />
          </div>
          <div className="ai-kpi-val">
            <strong style={{ fontSize: '18px' }}>
              {audit?.peakWindowAvailable || 'Aguardando dados'}
            </strong>
          </div>
          <small>Sugestão de horário, não previsão de alcance</small>
        </article>

        <article className="ai-kpi-card">
          <div className="ai-kpi-head">
            <span className="ai-kpi-label">Perfis Conectados</span>
            <Bot size={20} className="ai-icon-teal" />
          </div>
          <div className="ai-kpi-val">
            <strong>{audit?.activeAccounts ?? '—'}</strong>
            <span className="ai-sub-info">Perfis locais</span>
          </div>
          <small>Perfis cadastrados para automação</small>
        </article>
      </div>

      {audit && (
        <div className="ai-preflight" role="status">
          <div>
            <strong>Antes de executar</strong>
            <span>
              Revise os pontos abaixo; o piloto não substitui a confirmação exigida pelo
              Marketplace.
            </span>
          </div>
          <div className="ai-preflight-indicators">
            <span className={audit.activeAccounts > 0 ? 'is-ready' : 'needs-attention'}>
              <Check size={15} />{' '}
              {audit.activeAccounts > 0 ? 'Perfil disponível' : 'Conecte um perfil Brave'}
            </span>
            <span className={audit.readyVehicles > 0 ? 'is-ready' : 'needs-attention'}>
              <Check size={15} />{' '}
              {audit.readyVehicles > 0
                ? `${audit.readyVehicles} veículo(s) pronto(s)`
                : 'Nenhum veículo pronto'}
            </span>
          </div>
        </div>
      )}
      <article className="module-card" aria-label="Provedores e histórico da IA">
        <div className="module-head">
          <div>
            <h2>Provedores e histórico da IA</h2>
            <span>Eventos operacionais, sem armazenar textos completos nem chaves de API.</span>
          </div>
          <button className="secondary" type="button" onClick={() => void refreshAiHistory()}>
            <RotateCcw size={15} /> Atualizar histórico
          </button>
        </div>
        <p>
          Preferência: <strong>{providerStatus?.preference || 'carregando'}</strong>. Gemini:{' '}
          {providerStatus?.geminiConfigured ? 'configurado' : 'não configurado'}. OpenAI:{' '}
          {providerStatus?.openaiConfigured ? 'configurada' : 'não configurada'}. Fallback
          disponível: procedural (offline).
        </p>
        <p style={{ fontSize: 13 }}>
          O provedor configurado pode não ser o utilizado. A geração de descrições identifica o
          provedor real em cada proposta.
        </p>
        <div style={{ maxHeight: 220, overflowY: 'auto' }}>
          {aiHistory.length ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Horário (UTC)</th>
                  <th>Operação</th>
                  <th>Resultado</th>
                  <th>Provedor</th>
                  <th>Itens</th>
                </tr>
              </thead>
              <tbody>
                {aiHistory.slice(0, 20).map((event) => (
                  <tr key={event.id}>
                    <td>{event.createdAt}</td>
                    <td>{event.action}</td>
                    <td>{event.outcome}</td>
                    <td>{event.provider || '—'}</td>
                    <td>{event.items}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>Nenhuma operação registrada neste ambiente.</p>
          )}
        </div>
      </article>
      {/* Main Grid: Autopilot + Command Agent */}
      <div className="ai-two-column-grid">
        {/* Left Column: Autopilot Console & Quick Actions */}
        <div className="ai-column">
          <article className="module-card ai-card">
            <div className="module-head">
              <div>
                <h2>
                  <Zap size={18} style={{ color: '#10b981', display: 'inline', marginRight: 6 }} />
                  Piloto automático
                </h2>
                <span>Preparação e agendamento conforme suas regras</span>
              </div>
            </div>

            <ol className="ai-pipeline-steps">
              <li>
                <strong>Preparar textos</strong>
                <span>Enriquecer as descrições elegíveis conforme as configurações.</span>
              </li>
              <li>
                <strong>Selecionar estoque</strong>
                <span>Identificar veículos prontos e ainda não programados.</span>
              </li>
              <li>
                <strong>Distribuir perfis</strong>
                <span>Respeitar os perfis e limites de automação disponíveis.</span>
              </li>
              <li>
                <strong>Agendar publicações</strong>
                <span>Aplicar as janelas sugeridas sem ignorar confirmações de segurança.</span>
              </li>
            </ol>

            <div className="ai-actions-bar">
              <button
                type="button"
                className="primary ai-big-btn"
                onClick={handleRunAutopilot}
                disabled={runningAutopilot}
              >
                <Sparkles size={18} />
                {runningAutopilot ? 'Executando piloto...' : 'Executar piloto automático'}
              </button>

              <button
                type="button"
                className="secondary"
                onClick={handleBatchOptimize}
                disabled={optimizingBatch}
                title="Gera copies de IA para todos os carros que estiverem sem texto"
              >
                <FileText size={16} />
                {optimizingBatch ? 'Preparando prévia...' : 'Revisar descrições com IA'}
              </button>
            </div>

            {descriptionPreview && descriptionPreview.proposals.length > 0 && (
              <div
                className="ai-result-box"
                role="region"
                aria-label="Revisão das descrições propostas"
              >
                <strong>Revisar descrições antes de salvar</strong>
                <p>
                  {descriptionPreview.proposals.length} proposta(s) nesta rodada de até 10.
                  {descriptionPreview.remainingAfterBatch > 0
                    ? ' Outras ' + descriptionPreview.remainingAfterBatch + ' aguardam nova rodada.'
                    : ''}
                  Nenhuma alteração será feita até sua confirmação.
                </p>
                {descriptionPreview.proposals.map((proposal) => (
                  <div
                    key={proposal.vehicleId}
                    style={{ padding: '12px 0', borderBottom: '1px solid var(--border, #ccc)' }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={approvedDescriptionIds.includes(proposal.vehicleId)}
                        onChange={(event) =>
                          setApprovedDescriptionIds((current) =>
                            event.target.checked
                              ? [...current, proposal.vehicleId]
                              : current.filter((id) => id !== proposal.vehicleId),
                          )
                        }
                      />
                      <strong>{proposal.label}</strong>
                      <small>Gerado por: {proposal.provider}{proposal.fallbackReason ? ' · Fallback: ' + proposal.fallbackReason : ''}</small>
                    </label>
                    <details>
                      <summary>Comparar descrição atual e proposta</summary>
                      <p>
                        <strong>Original:</strong>
                      </p>
                      <p style={{ whiteSpace: 'pre-wrap' }}>
                        {proposal.original || '(sem descrição)'}
                      </p>
                      <p>
                        <strong>Proposta:</strong>
                      </p>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{proposal.proposed}</p>
                    </details>
                  </div>
                ))}
                <div className="ai-actions-bar">
                  <button
                    type="button"
                    className="primary"
                    disabled={optimizingBatch || approvedDescriptionIds.length === 0}
                    onClick={() => void handleApplyDescriptions()}
                  >
                    Aplicar {approvedDescriptionIds.length} descrição(ões) aprovada(s)
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={optimizingBatch}
                    onClick={() => {
                      setDescriptionPreview(null)
                      setApprovedDescriptionIds([])
                    }}
                  >
                    Descartar propostas
                  </button>
                </div>
              </div>
            )}

            {autopilotResult && (
              <div className="ai-result-box">
                <div className="ai-result-head">
                  <CheckCircle2 size={16} style={{ color: '#10b981' }} />
                  <strong>Resultado da Execução:</strong>
                </div>
                <p>{autopilotResult.message}</p>
                {autopilotResult.assignments.length > 0 && (
                  <ul className="ai-assignment-list">
                    {autopilotResult.assignments.map((item) => (
                      <li key={item.vehicleId}>
                        <span>{item.title}</span>
                        <small>
                          {item.accountLabel} ·{' '}
                          {new Date(item.scheduledAt).toLocaleTimeString('pt-BR', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}{' '}
                          ({item.window})
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </article>

          {/* AI Recommendations */}
          <article className="module-card ai-card">
            <div className="module-head">
              <div>
                <h2>Diagnósticos e oportunidades</h2>
                <span>Pontos de atenção identificados na auditoria</span>
              </div>
            </div>

            <div className="ai-rec-list">
              {audit?.recommendations.map((rec, i) => (
                <div key={i} className={`ai-rec-item ${rec.severity}`}>
                  <CircleAlert size={18} />
                  <div className="ai-rec-content">
                    <strong>{rec.title}</strong>
                    <p>{rec.description}</p>
                  </div>
                  {rec.actionIntent === 'run_autopilot' && (
                    <button className="small-action" onClick={handleRunAutopilot}>
                      Publicar
                    </button>
                  )}
                  {rec.actionIntent === 'optimize_descriptions' && (
                    <button className="small-action" onClick={handleBatchOptimize}>
                      Otimizar
                    </button>
                  )}
                  {rec.actionIntent === 'navigate_vehicles' && (
                    <button className="small-action" onClick={() => navigate('Veículos')}>
                      Ver carros
                    </button>
                  )}
                  {rec.actionIntent === 'navigate_team' && (
                    <button className="small-action" onClick={() => navigate('Equipe e contas')}>
                      Configurar
                    </button>
                  )}
                </div>
              ))}
              {(!audit?.recommendations || audit.recommendations.length === 0) && (
                <div className="ai-empty-rec">
                  <CheckCircle2 size={24} />
                  <p>
                    {loadingAudit
                      ? 'Consultando os diagnósticos...'
                      : audit
                        ? 'Nenhuma recomendação pendente nesta auditoria.'
                        : 'Auditoria indisponível. Use Atualizar diagnóstico para tentar novamente.'}
                  </p>
                </div>
              )}
            </div>
          </article>
        </div>

        {/* Right Column: Natural Language Agent Console */}
        <div className="ai-column">
          <article className="module-card ai-card ai-agent-console">
            <div className="module-head">
              <div>
                <h2>
                  <Bot size={18} style={{ color: '#3b82f6', display: 'inline', marginRight: 6 }} />
                  Assistente de operações
                </h2>
                <span>Comandos e respostas da operação em um só lugar</span>
              </div>
            </div>

            {/* Prompt suggestions */}
            <div className="ai-prompt-chips">
              <button
                onClick={() =>
                  void handleSendCommand('Executar piloto automático no estoque pronto')
                }
              >
                ⚡ Piloto Automático
              </button>
              <button
                onClick={() => void handleSendCommand('Otimizar descrições de todos os veículos')}
              >
                📝 Otimizar Textos
              </button>
              <button onClick={() => void handleSendCommand('Auditar saúde do estoque e gargalos')}>
                🔍 Auditar Estoque
              </button>
              <button onClick={() => void handleSendCommand('Revisar a organização dos grupos')}>
                🎯 Curar Grupos
              </button>
            </div>

            {/* Chat History */}
            <div className="ai-chat-history">
              {commandLogs.map((log) => (
                <div key={log.id} className="ai-chat-item">
                  <div className="ai-chat-user">
                    <span>Você</span>
                    <small>{log.timestamp}</small>
                  </div>
                  <div className="ai-chat-prompt">{log.prompt}</div>
                  <div className="ai-chat-bot">
                    <Bot size={16} />
                    <div className="ai-chat-reply">
                      {log.reply}
                      {log.actionTaken && (
                        <span className="ai-action-tag">Resultado: {log.actionTaken}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Input Bar */}
            <form
              className="ai-chat-input-form"
              onSubmit={(e) => {
                e.preventDefault()
                void handleSendCommand()
              }}
            >
              <input
                type="text"
                placeholder="Ex.: Agendar todo o estoque pronto nos horários de pico..."
                value={commandText}
                onChange={(e) => setCommandText(e.target.value)}
                disabled={commandLoading}
                aria-label="Comando para a IA"
              />
              <button
                type="submit"
                className="primary"
                disabled={commandLoading || !commandText.trim()}
              >
                <Send size={16} />
                {commandLoading ? 'Executando...' : 'Enviar'}
              </button>
            </form>
          </article>
        </div>
      </div>

      {/* Smart Vehicle Text Parser (WhatsApp / Ads -> Stock) */}
      <article className="module-card ai-card ai-reader-section">
        <div className="module-head">
          <div>
            <h2>
              <Copy size={18} style={{ color: '#f59e0b', display: 'inline', marginRight: 6 }} />
              Importar veículo a partir de texto
            </h2>
            <span>
              Cole textos de WhatsApp, notas de compra ou anúncios externos para cadastro automático
            </span>
          </div>
        </div>

        <form onSubmit={handleParseRawText} className="ai-reader-form">
          <label>
            <span>Texto do anúncio ou mensagem:</span>
            <textarea
              rows={3}
              placeholder="Ex.: Corolla XEi 2022 prata 42mil km revisado em concessionária flex automático R$ 119.900 único dono SP"
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              disabled={parsing}
              required
            />
          </label>

          <div className="ai-reader-actions">
            <button type="submit" className="primary" disabled={parsing || !rawText.trim()}>
              <Sparkles size={16} />
              {parsing ? 'Lendo e extraindo dados...' : 'Ler e Estruturar com IA'}
            </button>
            {parseMessage && <span className="ai-parse-status">{parseMessage}</span>}
          </div>
        </form>

        {parsedVehicle && (
          <div className="ai-parsed-card">
            <div className="ai-parsed-header">
              <Car size={20} />
              <div>
                <strong>
                  {parsedVehicle.year} {parsedVehicle.make} {parsedVehicle.model}{' '}
                  {parsedVehicle.trim}
                </strong>
                <small>
                  {money.format(parsedVehicle.price)} · {parsedVehicle.km.toLocaleString('pt-BR')}{' '}
                  km · {parsedVehicle.transmission}
                </small>
              </div>
              <button
                type="button"
                className="primary"
                onClick={handleSaveParsedToStock}
                disabled={savingParsed || !canSaveParsedVehicle}
              >
                <Plus size={16} />
                {savingParsed ? 'Cadastrando...' : 'Salvar no Estoque Agora'}
              </button>
            </div>

            <div className="ai-parsed-details-grid">
              <label>
                <span>Ano</span>
                <input
                  type="number"
                  min="1900"
                  max={new Date().getFullYear() + 1}
                  value={parsedVehicle.year || ''}
                  onChange={(e) =>
                    setParsedVehicle({ ...parsedVehicle, year: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                <span>Marca</span>
                <select
                  value={parsedVehicle.make}
                  onChange={(e) => setParsedVehicle({ ...parsedVehicle, make: e.target.value })}
                >
                  <option value="">Selecione...</option>
                  {VEHICLE_MAKES.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Modelo</span>
                <input
                  value={parsedVehicle.model}
                  onChange={(e) => setParsedVehicle({ ...parsedVehicle, model: e.target.value })}
                />
              </label>
              <label>
                <span>Versão</span>
                <input
                  value={parsedVehicle.trim}
                  onChange={(e) => setParsedVehicle({ ...parsedVehicle, trim: e.target.value })}
                />
              </label>
              <label>
                <span>Quilometragem</span>
                <input
                  type="number"
                  min="0"
                  value={parsedVehicle.km}
                  onChange={(e) =>
                    setParsedVehicle({ ...parsedVehicle, km: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                <span>Preço</span>
                <input
                  type="number"
                  min="1"
                  value={parsedVehicle.price || ''}
                  onChange={(e) =>
                    setParsedVehicle({ ...parsedVehicle, price: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <div className="ai-parsed-details-grid">
              <label>
                <span>Tipo de veículo</span>
                <select
                  value={parsedVehicle.vehicleType}
                  onChange={(e) =>
                    setParsedVehicle({ ...parsedVehicle, vehicleType: e.target.value })
                  }
                >
                  <option value="">Selecione...</option>
                  {VEHICLE_TYPES.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Carroceria</span>
                <select
                  value={parsedVehicle.bodyType}
                  onChange={(e) => setParsedVehicle({ ...parsedVehicle, bodyType: e.target.value })}
                >
                  <option value="">Selecione...</option>
                  {BODY_TYPES.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Condição</span>
                <select
                  value={parsedVehicle.condition}
                  onChange={(e) =>
                    setParsedVehicle({ ...parsedVehicle, condition: e.target.value })
                  }
                >
                  <option value="">Selecione...</option>
                  {VEHICLE_CONDITIONS.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Câmbio</span>
                <select
                  value={parsedVehicle.transmission}
                  onChange={(e) =>
                    setParsedVehicle({ ...parsedVehicle, transmission: e.target.value })
                  }
                >
                  <option value="">Selecione...</option>
                  {TRANSMISSIONS.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Combustível</span>
                <select
                  value={parsedVehicle.fuelType}
                  onChange={(e) => setParsedVehicle({ ...parsedVehicle, fuelType: e.target.value })}
                >
                  <option value="">Selecione...</option>
                  {FUEL_TYPES.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Cor externa</span>
                <select
                  value={parsedVehicle.exteriorColor}
                  onChange={(e) =>
                    setParsedVehicle({ ...parsedVehicle, exteriorColor: e.target.value })
                  }
                >
                  <option value="">Selecione...</option>
                  {VEHICLE_COLORS.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Cor interna</span>
                <select
                  value={parsedVehicle.interiorColor}
                  onChange={(e) =>
                    setParsedVehicle({ ...parsedVehicle, interiorColor: e.target.value })
                  }
                >
                  <option value="">Selecione...</option>
                  {VEHICLE_COLORS.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Localização</span>
                <input
                  value={parsedVehicle.location}
                  onChange={(e) => setParsedVehicle({ ...parsedVehicle, location: e.target.value })}
                />
              </label>
            </div>
            <label className="ai-parsed-description">
              <span>Descrição para o cadastro</span>
              <textarea
                rows={3}
                value={parsedVehicle.description}
                onChange={(e) =>
                  setParsedVehicle({ ...parsedVehicle, description: e.target.value })
                }
              />
            </label>
            {!canSaveParsedVehicle && (
              <small>
                Confira o texto extraído e preencha os campos obrigatórios antes de salvar. As
                informações não identificadas não são preenchidas automaticamente.
              </small>
            )}
          </div>
        )}
      </article>
    </section>
  )
}
