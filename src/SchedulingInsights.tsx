import { useEffect, useState } from 'react'
import { CalendarClock, TrendingUp } from 'lucide-react'

type Insight = {
  eligible: boolean
  totalSamples: number
  totalCompletions: number
  completionRate: number | null
  metric: string
  source: string
  topSlots: Array<{
    dayOfWeek: number
    hour: number
    samples: number
    completions: number
    observedRate: number
  }>
}
const week = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

export function SchedulingInsights({
  api,
}: {
  api: <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>
}) {
  const [data, setData] = useState<Insight | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    api<Insight>('/operations/scheduling-insights')
      .then((result) => {
        if (mounted) setData(result)
      })
      .catch(() => {
        if (mounted) setError('Não foi possível consultar as evidências de agendamento.')
      })
    return () => {
      mounted = false
    }
  }, [api])
  return (
    <article className="module-card">
      <div className="module-head">
        <div>
          <h2><CalendarClock size={18} /> Agendamento orientado por dados</h2>
          <span>Últimos 180 dias · resultados das execuções no AutoFlow</span>
        </div>
      </div>
      {error && <p role="status">{error}</p>}
      {!data && !error && <p>Carregando histórico...</p>}
      {data && (
        <>
          <p>
            {data.totalSamples} tentativas com resultado conhecido ·{' '}
            {data.completionRate === null
              ? 'sem dados suficientes'
              : `${data.completionRate}% de conclusão operacional`}
          </p>
          {!data.eligible ? (
            <p>Sem amostra suficiente para ajustar automaticamente os horários. Mantidas as janelas predefinidas.</p>
          ) : (
            <div className="compact-list">
              {data.topSlots.slice(0, 3).map((slot) => (
                <div key={`${slot.dayOfWeek}:${slot.hour}`}>
                  <span className="mini-car"><TrendingUp size={17} /></span>
                  <div>
                    <strong>{week[slot.dayOfWeek]} · {String(slot.hour).padStart(2, '0')}h</strong>
                    <small>{slot.completions}/{slot.samples} execuções concluídas ({slot.observedRate}%)</small>
                  </div>
                </div>
              ))}
            </div>
          )}
          <small>{data.metric} O histórico não garante maior alcance ou mais vendas.</small>
        </>
      )}
    </article>
  )
}
