import React, { useState, useEffect, useCallback } from 'react'
import {
  Sparkles, Bot, Play, Check, CircleAlert, RotateCcw,
  Clock, Gauge, Zap, Send, FileText, CheckCircle2,
  Copy, Plus, Car
} from 'lucide-react'
import type { VehicleRecord } from './Vehicles'

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

interface CommandLog {
  id: string
  timestamp: string
  prompt: string
  reply: string
  actionTaken?: string
}

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })

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
      reply: 'Olá! Sou o agente de operações de IA do AutoFlow. Posso ler anúncios crus, auditar estoque, otimizar textos em lote e agendar publicações nos horários de pico.',
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
  const [message, setMessage] = useState('')

  const loadAudit = useCallback(async () => {
    try {
      const res = await api<{ ok: boolean; audit: InventoryAudit }>('/ai/audit')
      if (res.ok) setAudit(res.audit)
    } catch {
      // Ignora falha de conexão inicial
    } finally {
      setLoadingAudit(false)
    }
  }, [api])

  useEffect(() => {
    let active = true
    api<{ ok: boolean; audit: InventoryAudit }>('/ai/audit')
      .then(res => {
        if (active && res.ok) setAudit(res.audit)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingAudit(false)
      })
    return () => {
      active = false
    }
  }, [api])

  async function handleRunAutopilot() {
    setRunningAutopilot(true)
    setAutopilotResult(null)
    try {
      const res = await api<AutopilotResult>('/ai/autopilot/run', { method: 'POST' })
      setAutopilotResult(res)
      setMessage(res.message)
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
      const res = await api<{ ok: boolean; intent: string; reply: string; actionTaken?: string }>('/ai/command', {
        method: 'POST',
        body: JSON.stringify({ prompt: text }),
      })
      const logEntry: CommandLog = {
        id: String(Date.now()),
        timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        prompt: text,
        reply: res.reply,
        actionTaken: res.actionTaken,
      }
      setCommandLogs(prev => [logEntry, ...prev])
      await loadAudit()
      await reloadVehicles()
    } catch (err) {
      const errEntry: CommandLog = {
        id: String(Date.now()),
        timestamp: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        prompt: text,
        reply: `Erro ao processar: ${err instanceof Error ? err.message : 'Falha na comunicação.'}`,
      }
      setCommandLogs(prev => [errEntry, ...prev])
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
      const res = await api<{ ok: boolean; vehicle: ParsedVehicle }>('/ai/parse-text', {
        method: 'POST',
        body: JSON.stringify({ text: rawText }),
      })
      if (res.ok) {
        setParsedVehicle(res.vehicle)
        setParseMessage(`Veículo extraído com ${Math.round(res.vehicle.confidence * 100)}% de confiança.`)
      }
    } catch (err) {
      setParseMessage(err instanceof Error ? err.message : 'Erro ao processar texto.')
    } finally {
      setParsing(false)
    }
  }

  async function handleSaveParsedToStock() {
    if (!parsedVehicle) return
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
          location: parsedVehicle.location,
          description: parsedVehicle.description,
          transmission: parsedVehicle.transmission,
          fuelType: parsedVehicle.fuelType,
          exteriorColor: parsedVehicle.exteriorColor,
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
    try {
      const res = await api<{ ok: boolean; updated: number }>('/ai/batch-optimize', {
        method: 'POST',
        body: JSON.stringify({ tone: 'vendedor' }),
      })
      setMessage(`${res.updated} descrições enriquecidas com IA com sucesso!`)
      await reloadVehicles()
      await loadAudit()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Erro ao otimizar descrições.')
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
          <button className="secondary" onClick={() => void loadAudit()} disabled={loadingAudit}>
            <RotateCcw size={16} />
            Atualizar auditoria
          </button>
          <button className="primary" onClick={handleRunAutopilot} disabled={runningAutopilot}>
            <Play size={16} />
            {runningAutopilot ? 'Executando...' : 'Executar Piloto Automático'}
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

      {/* KPI Cards */}
      <div className="ai-kpi-grid">
        <article className="ai-kpi-card">
          <div className="ai-kpi-head">
            <span className="ai-kpi-label">Saúde do Estoque</span>
            <Gauge size={20} className="ai-icon-green" />
          </div>
          <div className="ai-kpi-val">
            <strong>{audit?.healthScore ?? 100}%</strong>
            <span className={`ai-badge ${((audit?.healthScore ?? 100) >= 80) ? 'good' : 'warning'}`}>
              {((audit?.healthScore ?? 100) >= 80) ? 'Excelente' : 'Requer Atenção'}
            </span>
          </div>
          <small>{audit?.totalVehicles ?? vehicles.length} veículos cadastrados na base</small>
        </article>

        <article className="ai-kpi-card">
          <div className="ai-kpi-head">
            <span className="ai-kpi-label">Prontos p/ Publicação</span>
            <Check size={20} className="ai-icon-blue" />
          </div>
          <div className="ai-kpi-val">
            <strong>{audit?.readyVehicles ?? vehicles.filter(v => v.status === 'Pronto').length}</strong>
            <span className="ai-sub-info">
              {audit?.readyUnscheduled ?? 0} fora da fila
            </span>
          </div>
          <small>Prontos para envio autônomo</small>
        </article>

        <article className="ai-kpi-card">
          <div className="ai-kpi-head">
            <span className="ai-kpi-label">Próxima Janela de Pico</span>
            <Clock size={20} className="ai-icon-purple" />
          </div>
          <div className="ai-kpi-val">
            <strong style={{ fontSize: '18px' }}>{audit?.peakWindowAvailable || 'Pico Automotivo'}</strong>
          </div>
          <small>Tráfego máximo no Facebook Marketplace</small>
        </article>

        <article className="ai-kpi-card">
          <div className="ai-kpi-head">
            <span className="ai-kpi-label">Perfis Conectados</span>
            <Bot size={20} className="ai-icon-teal" />
          </div>
          <div className="ai-kpi-val">
            <strong>{audit?.activeAccounts ?? 1}</strong>
            <span className="ai-sub-info">Perfis locais</span>
          </div>
          <small>Sessões do Brave balanceadas por IA</small>
        </article>
      </div>

      {/* Main Grid: Autopilot + Command Agent */}
      <div className="ai-two-column-grid">
        {/* Left Column: Autopilot Console & Quick Actions */}
        <div className="ai-column">
          <article className="module-card ai-card">
            <div className="module-head">
              <div>
                <h2>
                  <Zap size={18} style={{ color: '#10b981', display: 'inline', marginRight: 6 }} />
                  Piloto Automático (1 Clique)
                </h2>
                <span>Pipeline 100% autônomo de publicação</span>
              </div>
            </div>

            <p className="ai-desc-text">
              O piloto automático realiza 4 ações em sequência:
              <br />
              <b>1.</b> Enriquece veículos prontos que estão sem descrição usando IA e hashtags de conversão.
              <br />
              <b>2.</b> Seleciona todos os carros prontos que ainda não estão em publicação.
              <br />
              <b>3.</b> Associa automaticamente ao perfil local do Brave mais adequado.
              <br />
              <b>4.</b> Agenda nas melhores janelas de pico brasileiras com jitter anti-bloqueio.
            </p>

            <div className="ai-actions-bar">
              <button
                type="button"
                className="primary ai-big-btn"
                onClick={handleRunAutopilot}
                disabled={runningAutopilot}
              >
                <Sparkles size={18} />
                {runningAutopilot ? 'Executando pipeline...' : 'Disparar Piloto Automático'}
              </button>

              <button
                type="button"
                className="secondary"
                onClick={handleBatchOptimize}
                disabled={optimizingBatch}
                title="Gera copies de IA para todos os carros que estiverem sem texto"
              >
                <FileText size={16} />
                {optimizingBatch ? 'Otimizando...' : 'Otimizar Todas as Descrições'}
              </button>
            </div>

            {autopilotResult && (
              <div className="ai-result-box">
                <div className="ai-result-head">
                  <CheckCircle2 size={16} style={{ color: '#10b981' }} />
                  <strong>Resultado da Execução:</strong>
                </div>
                <p>{autopilotResult.message}</p>
                {autopilotResult.assignments.length > 0 && (
                  <ul className="ai-assignment-list">
                    {autopilotResult.assignments.map(item => (
                      <li key={item.vehicleId}>
                        <span>{item.title}</span>
                        <small>
                          {item.accountLabel} · {new Date(item.scheduledAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} ({item.window})
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
                <h2>Diagnósticos & Oportunidades do Estoque</h2>
                <span>Recomendações geradas em tempo real</span>
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
                  <CheckCircle2 size={24} style={{ color: '#10b981' }} />
                  <p>Tudo perfeito! O estoque está otimizado e pronto para vendas.</p>
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
                  Agente de Comandos em Linguagem Natural
                </h2>
                <span>Controle o AutoFlow conversando com a IA</span>
              </div>
            </div>

            {/* Prompt suggestions */}
            <div className="ai-prompt-chips">
              <button onClick={() => void handleSendCommand('Executar piloto automático no estoque pronto')}>
                ⚡ Piloto Automático
              </button>
              <button onClick={() => void handleSendCommand('Otimizar descrições de todos os veículos')}>
                📝 Otimizar Textos
              </button>
              <button onClick={() => void handleSendCommand('Auditar saúde do estoque e gargalos')}>
                🔍 Auditar Estoque
              </button>
              <button onClick={() => void handleSendCommand('Reordenar grupos por taxa de conversão')}>
                🎯 Curar Grupos
              </button>
            </div>

            {/* Chat History */}
            <div className="ai-chat-history">
              {commandLogs.map(log => (
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
                        <span className="ai-action-tag">Ação executada: {log.actionTaken}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Input Bar */}
            <form
              className="ai-chat-input-form"
              onSubmit={e => {
                e.preventDefault()
                void handleSendCommand()
              }}
            >
              <input
                type="text"
                placeholder="Ex.: Agendar todo o estoque pronto nos horários de pico..."
                value={commandText}
                onChange={e => setCommandText(e.target.value)}
                disabled={commandLoading}
                aria-label="Comando para a IA"
              />
              <button type="submit" className="primary" disabled={commandLoading || !commandText.trim()}>
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
              Leitor Inteligente de Veículos (Texto Cru ➔ Estoque)
            </h2>
            <span>Cole textos de WhatsApp, notas de compra ou anúncios externos para cadastro automático</span>
          </div>
        </div>

        <form onSubmit={handleParseRawText} className="ai-reader-form">
          <label>
            <span>Texto do anúncio ou mensagem:</span>
            <textarea
              rows={3}
              placeholder="Ex.: Corolla XEi 2022 prata 42mil km revisado em concessionária flex automático R$ 119.900 único dono SP"
              value={rawText}
              onChange={e => setRawText(e.target.value)}
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
                <strong>{parsedVehicle.year} {parsedVehicle.make} {parsedVehicle.model} {parsedVehicle.trim}</strong>
                <small>{money.format(parsedVehicle.price)} · {parsedVehicle.km.toLocaleString('pt-BR')} km · {parsedVehicle.transmission}</small>
              </div>
              <button
                type="button"
                className="primary"
                onClick={handleSaveParsedToStock}
                disabled={savingParsed}
              >
                <Plus size={16} />
                {savingParsed ? 'Cadastrando...' : 'Salvar no Estoque Agora'}
              </button>
            </div>

            <div className="ai-parsed-details-grid">
              <div><span>Ano:</span> <b>{parsedVehicle.year}</b></div>
              <div><span>Marca:</span> <b>{parsedVehicle.make}</b></div>
              <div><span>Modelo:</span> <b>{parsedVehicle.model}</b></div>
              <div><span>Versão:</span> <b>{parsedVehicle.trim || '—'}</b></div>
              <div><span>KM:</span> <b>{parsedVehicle.km.toLocaleString('pt-BR')} km</b></div>
              <div><span>Preço:</span> <b>{money.format(parsedVehicle.price)}</b></div>
              <div><span>Câmbio:</span> <b>{parsedVehicle.transmission}</b></div>
              <div><span>Combustível:</span> <b>{parsedVehicle.fuelType}</b></div>
              <div><span>Cor:</span> <b>{parsedVehicle.exteriorColor}</b></div>
              <div><span>Local:</span> <b>{parsedVehicle.location}</b></div>
            </div>
          </div>
        )}
      </article>
    </section>
  )
}
