import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'

type Report = {
  timestamp: string
  healthy: boolean
  stuckJobsCount: number
  slowJobsCount: number
  recoveredCount: number
  warningCount: number
  jobs: { pending: number; active: number; awaitingConfirmation: number }
  performance: { completed: number; errors: number; averageDurationSeconds: number | null }
  accounts: Array<{
    id: number
    label: string
    completed: number
    errors: number
    successRate: number | null
  }>
  autopilot: {
    enabled: number
    running: number
    intervalMinutes: number
    lastStatus: string | null
    lastFinishedAt: string | null
    lastJobsCreated: number
  }
}

function displayTime(value: string): string {
  const instant = new Date(
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(' ', 'T') + 'Z',
  )
  return instant.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function OperationalHealth({ api }: { api: <T>(path: string) => Promise<T> }) {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        const result = await api<Report>('/health/detailed')
        if (active) {
          setReport(result)
          setError('')
        }
      } catch {
        if (active) setError('Não foi possível atualizar a saúde da operação.')
      } finally {
        // Schedule after completion: no overlapping polls or updates after unmount.
        if (active)
          timer = setTimeout(() => {
            void refresh()
          }, 30_000)
      }
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api])

  return (
    <article className="module-card operational-health">
      <div className="module-head">
        <div>
          <h2>
            <Activity size={19} /> Saúde da operação
          </h2>
          <span>
            {report ? `Atualizado em ${displayTime(report.timestamp)}` : 'Consultando a operação…'}
          </span>
        </div>
        {report && !error && (
          <span className={`health-badge ${report.healthy ? 'healthy' : 'attention'}`}>
            {report.healthy ? 'Operação estável' : 'Requer atenção'}
          </span>
        )}
      </div>
      {error && (
        <p role="status" className="health-error">
          {error} {report ? 'Os dados abaixo são da última atualização.' : ''}
        </p>
      )}
      {report && (
        <>
          <dl className="health-counts">
            <div>
              <dt>Na fila</dt>
              <dd>{report.jobs.pending}</dd>
            </div>
            <div>
              <dt>Em execução</dt>
              <dd>{report.jobs.active}</dd>
            </div>
            <div>
              <dt>Execuções demoradas</dt>
              <dd>{report.slowJobsCount}</dd>
            </div>
            <div>
              <dt>Travados</dt>
              <dd>{report.stuckJobsCount}</dd>
            </div>
            <div>
              <dt>Aguardando confirmação</dt>
              <dd>{report.jobs.awaitingConfirmation}</dd>
            </div>
            <div>
              <dt>Recuperações · 24h</dt>
              <dd>{report.recoveredCount}</dd>
            </div>
            <div>
              <dt>Avisos de demora · 24h</dt>
              <dd>{report.warningCount}</dd>
            </div>
            <div>
              <dt>Tempo médio · 24h</dt>
              <dd>
                {report.performance.averageDurationSeconds === null
                  ? '—'
                  : `${Math.round(report.performance.averageDurationSeconds)} s`}
              </dd>
            </div>
          </dl>
          <p className="health-autopilot">
            <strong>
              Agendamento recorrente: {report.autopilot.enabled ? 'ativo' : 'desligado'}.
            </strong>{' '}
            {report.autopilot.enabled
              ? `Consulta o estoque a cada ${report.autopilot.intervalMinutes} min. `
              : ''}
            {report.autopilot.running
              ? 'Uma rodada está em execução.'
              : report.autopilot.lastStatus === 'error'
                ? 'A última rodada falhou; consulte os logs da API.'
                : report.autopilot.lastFinishedAt
                  ? `Última rodada: ${displayTime(report.autopilot.lastFinishedAt)}, ${report.autopilot.lastJobsCreated} jobs criados.`
                  : 'Nenhuma rodada registrada.'}
          </p>
          {report.accounts.length > 0 && (
            <div className="health-table-wrap">
              <table className="health-table">
                <caption>Resultados por perfil nas últimas 24 horas</caption>
                <thead>
                  <tr>
                    <th scope="col">Perfil</th>
                    <th scope="col">Publicados</th>
                    <th scope="col">Em erro</th>
                    <th scope="col">Sucesso</th>
                  </tr>
                </thead>
                <tbody>
                  {report.accounts.map((account) => (
                    <tr key={account.id}>
                      <th scope="row">{account.label}</th>
                      <td>{account.completed}</td>
                      <td>{account.errors}</td>
                      <td>
                        {account.successRate === null
                          ? '—'
                          : `${Math.round(account.successRate * 100)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="health-note">
            Sucesso considera jobs publicados ou removidos entre os publicados e os que permanecem
            em erro no período. O tempo médio mede do início do preenchimento à conclusão
            registrada; execuções em andamento ficam fora do cálculo.
          </p>
        </>
      )}
    </article>
  )
}
