import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ClipboardCheck, History, RefreshCcw } from 'lucide-react'
import './InterventionCenter.css'

type Api = <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>
type Incident = {
  id: number
  jobId: number
  kind: string
  severity: 'warning' | 'critical'
  status: 'open' | 'acknowledged' | 'resolved'
  summary: string
  occurrenceCount: number
  lastSeenAt: string
  vehicleTitle: string
  accountLabel: string
  jobStatus: string
}
type Activity = {
  id: number
  jobId: number
  eventType: string
  createdAt: string
  vehicleTitle: string
}
type IncidentAction = {
  id: number
  action: string
  note: string
  createdAt: string
  actorName: string | null
}
type Overview = {
  incidents: Incident[]
  totals: { total: number; open: number; acknowledged: number; resolved: number; critical: number }
}

const labels: Record<string, string> = {
  publication_uncertain: 'Publicação incerta',
  execution_error: 'Falha de execução',
  selector_drift: 'Formulário alterado',
  duplicate_risk: 'Risco de duplicidade',
  slow_execution: 'Execução demorada',
  opened: 'Ocorrência registrada',
  reopened: 'Ocorrência reaberta',
  occurred: 'Nova ocorrência',
  acknowledged: 'Reconhecida',
  resolved: 'Encerrada pelo operador',
  auto_resolved: 'Resolvida pela operação',
}

function dateTime(value: string) {
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z')
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('pt-BR')
}

export function InterventionCenter({
  api,
  canManage,
  navigate,
}: {
  api: Api
  canManage: boolean
  navigate: (page: string) => void
}) {
  const [status, setStatus] = useState('active')
  const [data, setData] = useState<Overview | null>(null)
  const [activity, setActivity] = useState<Activity[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [history, setHistory] = useState<IncidentAction[]>([])
  const [message, setMessage] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [refresh, setRefresh] = useState(0)

  const load = useCallback(async () => {
    const [incidents, recent] = await Promise.all([
      api<Overview>(`/operations/incidents?status=${encodeURIComponent(status)}&limit=30`),
      api<{ activity: Activity[] }>('/operations/activity?limit=12'),
    ])
    setData(incidents)
    setActivity(recent.activity)
  }, [api, status])

  useEffect(() => {
    let mounted = true
    let busy = false
    const reload = async () => {
      if (busy) return
      busy = true
      try {
        const [incidents, recent] = await Promise.all([
          api<Overview>(`/operations/incidents?status=${encodeURIComponent(status)}&limit=30`),
          api<{ activity: Activity[] }>('/operations/activity?limit=12'),
        ])
        if (mounted) {
          setData(incidents)
          setActivity(recent.activity)
          setMessage('')
        }
      } catch (error) {
        if (mounted)
          setMessage(error instanceof Error ? error.message : 'Não foi possível carregar a central.')
      } finally {
        busy = false
      }
    }
    void reload()
    const timer = window.setInterval(() => void reload(), 30000)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [api, status, refresh])

  async function showHistory(id: number) {
    if (selected === id) {
      setSelected(null)
      return
    }
    setSelected(id)
    setHistory([])
    try {
      const result = await api<{ history: IncidentAction[] }>(
        `/operations/incidents/${id}/history`,
      )
      setHistory(result.history)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível abrir o histórico.')
    }
  }

  async function act(incident: Incident, action: 'acknowledge' | 'resolve') {
    if (busyId) return
    setBusyId(incident.id)
    try {
      await api(`/operations/incidents/${incident.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      })
      await load()
      if (selected === incident.id) {
        const result = await api<{ history: IncidentAction[] }>(
          `/operations/incidents/${incident.id}/history`,
        )
        setHistory(result.history)
      }
      setMessage(action === 'acknowledge' ? 'Ocorrência reconhecida.' : 'Ocorrência encerrada.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível tratar a ocorrência.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="intervention-panel" aria-label="Central de intervenções">
      <div className="intervention-head">
        <div>
          <span className="page-kicker">OBSERVABILIDADE</span>
          <h2>Central de intervenções</h2>
          <p>Alertas persistentes, confirmação humana e histórico das tentativas.</p>
        </div>
        <button
          type="button"
          className="intervention-refresh"
          onClick={() => setRefresh((value) => value + 1)}
          title="Atualizar ocorrências"
        >
          <RefreshCcw size={16} /> Atualizar
        </button>
      </div>
      <div className="intervention-stats">
        <div><strong>{data?.totals.open ?? '—'}</strong><span>Novas</span></div>
        <div><strong>{data?.totals.acknowledged ?? '—'}</strong><span>Reconhecidas</span></div>
        <div><strong>{data?.totals.critical ?? '—'}</strong><span>Críticas ativas</span></div>
        <div><strong>{data?.totals.resolved ?? '—'}</strong><span>Encerradas</span></div>
      </div>
      <div className="intervention-filter">
        <label htmlFor="intervention-status">Situação</label>
        <select id="intervention-status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="active">Pendentes</option>
          <option value="open">Novas</option>
          <option value="acknowledged">Reconhecidas</option>
          <option value="resolved">Encerradas</option>
          <option value="all">Todas</option>
        </select>
      </div>
      {message && <p className="intervention-message" role="status">{message}</p>}
      <div className="intervention-list">
        {data?.incidents.map((incident) => (
          <article key={incident.id} className="intervention-item">
            <div className="intervention-main">
              <span className={incident.severity === 'critical' ? 'intervention-icon critical' : 'intervention-icon warning'}>
                {incident.severity === 'critical' ? <AlertTriangle size={18} /> : <ClipboardCheck size={18} />}
              </span>
              <div className="intervention-detail">
                <strong>{labels[incident.kind] || incident.kind} · #{incident.jobId}</strong>
                <small>{incident.vehicleTitle} · {incident.accountLabel}</small>
                <p>{incident.summary}</p>
                <small>{dateTime(incident.lastSeenAt)} · {incident.occurrenceCount} ocorrência(s) · {incident.status === 'resolved' ? 'Encerrada' : incident.status === 'acknowledged' ? 'Reconhecida' : 'Nova'}</small>
              </div>
            </div>
            <div className="intervention-actions">
              <button type="button" onClick={() => navigate('Publicações')}>Abrir publicações</button>
              {canManage && incident.status === 'open' && (
                <button type="button" disabled={busyId !== null} onClick={() => void act(incident, 'acknowledge')}>
                  <ClipboardCheck size={14} /> Reconhecer
                </button>
              )}
              {canManage && incident.status !== 'resolved' && (
                <button type="button" disabled={busyId !== null || (incident.kind === 'publication_uncertain' && incident.jobStatus === 'awaiting_confirmation')} title="Ocorrências de publicação incerta só podem ser encerradas após a confirmação em Publicações" onClick={() => void act(incident, 'resolve')}>
                  <CheckCircle2 size={14} /> Encerrar
                </button>
              )}
              <button type="button" onClick={() => void showHistory(incident.id)} aria-expanded={selected === incident.id}>
                <History size={14} /> Histórico <ChevronDown size={13} />
              </button>
            </div>
            {selected === incident.id && (
              <ul className="intervention-history">
                {history.map((entry) => (
                  <li key={entry.id}>
                    <strong>{labels[entry.action] || entry.action}</strong>
                    <span>{dateTime(entry.createdAt)} · {entry.actorName || 'Sistema'}{entry.note ? ` · ${entry.note}` : ''}</span>
                  </li>
                ))}
                {!history.length && <li>Carregando ou sem registros.</li>}
              </ul>
            )}
          </article>
        ))}
        {data && data.incidents.length === 0 && (
          <p className="intervention-empty">Nenhuma ocorrência para o filtro selecionado.</p>
        )}
      </div>
      <div className="intervention-activity">
        <h3>Histórico recente de tentativas</h3>
        <p>Eventos da operação registrados no servidor, em ordem cronológica reversa.</p>
        {activity.map((entry) => (
          <div key={entry.id}>
            <span>{dateTime(entry.createdAt)}</span>
            <strong>#{entry.jobId} · {entry.vehicleTitle}</strong>
            <code>{entry.eventType.replaceAll('_', ' ')}</code>
          </div>
        ))}
        {!activity.length && <p>Sem eventos recentes.</p>}
      </div>
    </section>
  )
}
