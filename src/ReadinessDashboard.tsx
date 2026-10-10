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
type GuidedAction = {
  id: string
  checkId: string
  priority: 'critical' | 'high' | 'normal' | 'verification'
  title: string
  summary: string
  reason: string
  steps: string[]
  destination: string
  destinationLabel: string
  safety: string
  requiresHumanApproval: true
  performsChanges: false
}

const guidancePriority: Record<GuidedAction['priority'], string> = {
  critical: 'Prioridade alta · publicações e dados',
  high: 'Prioridade de operação',
  normal: 'Ajuste de configuração',
  verification: 'Verificação recomendada',
}

type Report = {
  generatedAt: string
  evidence: string
  status: 'ready' | 'attention' | 'idle'
  summary: { attention: number; configured: number; inactive: number; unverified: number }
  checks: ReadinessCheck[]
  guides: GuidedAction[]
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
  const [expandedGuide, setExpandedGuide] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({})
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
          <article className="module-card" aria-label="Assistente de correção guiada">
            <div className="module-head">
              <div>
                <h2>
                  <ShieldCheck size={18} /> Assistente de correção guiada
                </h2>
                <span>
                  {report.guides.length
                    ? report.guides.length +
                      ' roteiro(s) para revisão manual, em ordem de prioridade.'
                    : 'Nenhuma pendência com roteiro disponível no diagnóstico atual.'}
                </span>
              </div>
              {Object.values(reviewed).some(Boolean) && (
                <button className="secondary" type="button" onClick={() => setReviewed({})}>
                  Limpar marcações
                </button>
              )}
            </div>
            <p className="health-note">
              Este assistente explica como verificar e corrigir problemas. Ele não altera
              configurações, credenciais, grupos ou publicações. Marcar um passo significa apenas
              que você o conferiu; não comprova que o problema foi resolvido.
            </p>
            <div style={{ display: 'grid', gap: 12 }}>
              {report.guides.map((guide, index) => {
                const opened = expandedGuide === guide.id
                const checked = guide.steps.filter(
                  (_, step) => reviewed[guide.id + ':' + step],
                ).length
                return (
                  <div
                    key={guide.id}
                    style={{
                      border: '1px solid var(--line, #dce5e4)',
                      borderRadius: 12,
                      padding: 16,
                    }}
                  >
                    <button
                      type="button"
                      className="secondary"
                      aria-expanded={opened}
                      aria-controls={'remediation-detail-' + guide.id}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}
                      onClick={() => setExpandedGuide(opened ? null : guide.id)}
                    >
                      <span>
                        <strong>
                          {index + 1}. {guide.title}
                        </strong>
                        <small style={{ display: 'block', marginTop: 5 }}>
                          {guidancePriority[guide.priority]} · {guide.summary}
                        </small>
                      </span>
                      <span aria-hidden="true">{opened ? '−' : '+'}</span>
                    </button>
                    {opened && (
                      <div id={'remediation-detail-' + guide.id} style={{ marginTop: 15 }}>
                        <p>
                          <strong>Por que revisar:</strong> {guide.reason}
                        </p>
                        <ol style={{ display: 'grid', gap: 10, paddingLeft: 22 }}>
                          {guide.steps.map((step, i) => (
                            <li key={guide.id + ':' + i}>
                              <label
                                style={{
                                  display: 'flex',
                                  gap: 9,
                                  alignItems: 'flex-start',
                                  cursor: 'pointer',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  aria-label={'Etapa ' + (i + 1) + ': ' + step}
                                  checked={Boolean(reviewed[guide.id + ':' + i])}
                                  onChange={(e) => {
                                    const value = e.target.checked
                                    setReviewed((current) => ({
                                      ...current,
                                      [guide.id + ':' + i]: value,
                                    }))
                                  }}
                                />
                                <span>{step}</span>
                              </label>
                            </li>
                          ))}
                        </ol>
                        <p className="health-note">
                          {checked} de {guide.steps.length} etapas conferidas nesta tela.
                        </p>
                        <p className="health-note">
                          <strong>Limite de segurança:</strong> {guide.safety}
                        </p>
                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            alignItems: 'center',
                            gap: 10,
                          }}
                        >
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => navigate(guide.destination)}
                          >
                            {guide.destinationLabel} <ArrowRight size={15} />
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            disabled={refreshing}
                            onClick={() => void load()}
                          >
                            <RefreshCcw size={14} /> Reavaliar diagnóstico
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              {!report.guides.length && (
                <p className="health-note">
                  As condições básicas não mostraram alertas cobertos por roteiros. Integrações
                  externas e backups continuam exigindo validação independente.
                </p>
              )}
            </div>
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
