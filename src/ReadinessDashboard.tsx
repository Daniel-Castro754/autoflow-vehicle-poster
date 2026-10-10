import { useCallback, useEffect, useState } from 'react'
import { Activity, ArrowRight, RefreshCcw, ShieldCheck } from 'lucide-react'

type Status = 'ok' | 'attention' | 'inactive' | 'unknown'
type Section = 'security' | 'integrations' | 'automation'
type ReadinessCheck = {
  id: string
  section: Section
  title: string
  status: Status
  detail: string
  page: string
}
type Report = {
  generatedAt: string
  evidence: string
  status: 'ready' | 'attention' | 'idle'
  summary: { attention: number; configured: number; inactive: number; unverified: number }
  checks: ReadinessCheck[]
  automation: {
    enabled: boolean
    autoPublish: boolean
    autoAdvance: boolean
    lastStatus: string | null
    basicCandidates: number
    activeGroups: number
    totalProfiles: number
    recentProfiles: number
    pausedProfiles: number
  }
}

const textByStatus: Record<Status, string> = {
  ok: 'Configurado / condições básicas',
  attention: 'Precisa de atenção',
  inactive: 'Desativado ou aguardando',
  unknown: 'Não verificado',
}
const colorByStatus: Record<Status, string> = {
  ok: '#217c59',
  attention: '#b36b2d',
  inactive: '#66768b',
  unknown: '#60768d',
}
const sections: Array<{ id: Section; title: string }> = [
  { id: 'security', title: 'Segurança e recuperação' },
  { id: 'integrations', title: 'Integrações externas' },
  { id: 'automation', title: 'Autonomia e publicações' },
]

function displayMoment(iso: string) {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
}

export function ReadinessDashboard({
  api,
  navigate,
}: {
  api: <T = unknown>(path: string, options?: RequestInit) => Promise<T>
  navigate: (page: string) => void
}) {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      const response = await api<Report>('/health/readiness')
      setReport(response)
      setError('')
    } catch {
      setError('Não foi possível atualizar o diagnóstico. Confira a conexão e sua permissão.')
    } finally {
      setRefreshing(false)
    }
  }, [api])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    // Passive snapshots only; never trigger credential tests or publication actions.
    async function poll() {
      if (!active) return
      try {
        const result = await api<Report>('/health/readiness')
        if (active) {
          setReport(result)
          setError('')
        }
      } catch {
        if (active) setError('Não foi possível consultar o diagnóstico. Últimos dados exibidos.')
      } finally {
        if (active) timer = setTimeout(() => void poll(), 60_000)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api])

  return (
    <section className="content" aria-label="Saúde e autonomia">
      <div className="title-row">
        <div>
          <span className="page-kicker">DIAGNÓSTICO DE CONFIGURAÇÃO</span>
          <h1>Saúde e autonomia</h1>
          <p>Verifique integrações, segurança e prontidão básica antes de executar automações.</p>
        </div>
        <button
          className="secondary"
          type="button"
          disabled={refreshing}
          onClick={() => void load()}
        >
          <RefreshCcw size={16} /> {refreshing ? 'Atualizando...' : 'Atualizar diagnóstico'}
        </button>
      </div>
      {error && (
        <p role="status" className="health-error">
          {error}
        </p>
      )}
      {report ? (
        <>
          <article className="module-card" aria-label="Resumo do diagnóstico">
            <div className="module-head">
              <div>
                <h2>
                  <Activity size={18} /> Resumo do ambiente
                </h2>
                <span>Última leitura: {displayMoment(report.generatedAt)}</span>
              </div>
              <span
                className={'health-badge ' + (report.status === 'ready' ? 'healthy' : 'attention')}
              >
                {report.status === 'attention'
                  ? 'Requer revisão'
                  : report.status === 'ready'
                    ? 'Pré-condições presentes'
                    : 'Aguardando condições'}
              </span>
            </div>
            <dl className="health-counts">
              <div>
                <dt>Precisam de atenção</dt>
                <dd>{report.summary.attention}</dd>
              </div>
              <div>
                <dt>Condições básicas</dt>
                <dd>{report.summary.configured}</dd>
              </div>
              <div>
                <dt>Inativos / aguardando</dt>
                <dd>{report.summary.inactive}</dd>
              </div>
              <div>
                <dt>Sem verificação</dt>
                <dd>{report.summary.unverified}</dd>
              </div>
            </dl>
            <p className="health-note">
              <ShieldCheck size={16} /> {report.evidence}
            </p>
            <p className="health-note">
              Modo autônomo: <strong>{report.automation.enabled ? 'ligado' : 'desligado'}</strong>.{' '}
              Publicação automática:{' '}
              <strong>{report.automation.autoPublish ? 'ligada' : 'desligada'}</strong>. Veículos
              candidatos: <strong>{report.automation.basicCandidates}</strong>. Extensões recentes:{' '}
              <strong>
                {report.automation.recentProfiles}/{report.automation.totalProfiles}
              </strong>
              .
            </p>
          </article>
          {sections.map(({ id, title }) => (
            <article className="module-card" key={id} aria-label={title}>
              <div className="module-head">
                <div>
                  <h2>{title}</h2>
                  <span>O diagnóstico não altera configurações nem agenda trabalhos.</span>
                </div>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))',
                  gap: 12,
                }}
              >
                {report.checks
                  .filter((item) => item.section === id)
                  .map((item) => (
                    <div
                      key={item.id}
                      style={{
                        border: '1px solid var(--line, #dce5e4)',
                        borderRadius: 12,
                        padding: 16,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          gap: 8,
                        }}
                      >
                        <strong>{item.title}</strong>
                        <span
                          style={{
                            color: colorByStatus[item.status],
                            fontWeight: 650,
                            fontSize: 12,
                          }}
                        >
                          {textByStatus[item.status]}
                        </span>
                      </div>
                      <p style={{ marginTop: 10, marginBottom: 14, fontSize: 14 }}>{item.detail}</p>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => navigate(item.page)}
                      >
                        Ver {item.page.toLowerCase()} <ArrowRight size={14} />
                      </button>
                    </div>
                  ))}
              </div>
            </article>
          ))}
        </>
      ) : !error ? (
        <p role="status">Consultando indicadores locais...</p>
      ) : null}
    </section>
  )
}
