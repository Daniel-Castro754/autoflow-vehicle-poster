import { useEffect, useState } from 'react'

type Api = <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>
type Capacity = {
  dailyLimit: number
  intervalMinutes: number
  organizationDailyLimit: number
  organizationIntervalMinutes: number
  dailyLimitOverride: number | null
  intervalMinutesOverride: number | null
  used: number
  remaining: number
  queuedToday: number
  nextAllowedAt: string | null
}

export function ProfileCapacityEditor({ api, accountId }: { api: Api; accountId: number }) {
  const [capacity, setCapacity] = useState<Capacity | null>(null)
  const [daily, setDaily] = useState('')
  const [minutes, setMinutes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  function apply(result: Capacity) {
    setCapacity(result)
    setDaily(result.dailyLimitOverride === null ? '' : String(result.dailyLimitOverride))
    setMinutes(result.intervalMinutesOverride === null ? '' : String(result.intervalMinutesOverride))
  }

  useEffect(() => {
    let active = true
    void api<Capacity>('/social-accounts/' + accountId + '/capacity')
      .then((result) => {
        if (active) {
          setCapacity(result)
          setDaily(result.dailyLimitOverride === null ? '' : String(result.dailyLimitOverride))
          setMinutes(
            result.intervalMinutesOverride === null ? '' : String(result.intervalMinutesOverride),
          )
        }
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Falha ao consultar capacidade.')
      })
    return () => {
      active = false
    }
  }, [api, accountId])

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError('')
    setMessage('')
    try {
      const next = await api<Capacity>('/social-accounts/' + accountId + '/capacity', {
        method: 'PATCH',
        body: JSON.stringify({
          dailyLimitOverride: daily === '' ? null : Number(daily),
          intervalMinutesOverride: minutes === '' ? null : Number(minutes),
        }),
      })
      apply(next)
      setMessage('Limites operacionais atualizados.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar os limites.')
    } finally {
      setLoading(false)
    }
  }

  if (!capacity) return <small role="status">{error || 'Carregando limites operacionais…'}</small>

  return (
    <form className="profile-capacity" onSubmit={(event) => void save(event)}>
      <div className="profile-capacity-stats">
        <strong>Capacidade do perfil</strong>
        <small>{capacity.used}/{capacity.dailyLimit} execuções hoje · {capacity.queuedToday} trabalhos criados hoje</small>
      </div>
      <div className="profile-capacity-fields">
        <label>
          Limite diário
          <input type="number" min="1" max={capacity.organizationDailyLimit} value={daily}
            placeholder={String(capacity.organizationDailyLimit)}
            onChange={(event) => setDaily(event.target.value)} disabled={loading} />
        </label>
        <label>
          Intervalo (min)
          <input type="number" min="0" max="1440" value={minutes}
            placeholder={String(capacity.organizationIntervalMinutes)}
            onChange={(event) => setMinutes(event.target.value)} disabled={loading} />
        </label>
        <button type="submit" className="secondary" disabled={loading}>
          {loading ? 'Salvando...' : 'Salvar limites'}
        </button>
      </div>
      <small>Campos vazios herdam os padrões da empresa. Esses limites são internos, não regras oficiais da plataforma.</small>
      {capacity.nextAllowedAt && (
        <small>Próxima execução possível após {new Date(capacity.nextAllowedAt).toLocaleString('pt-BR')}.</small>
      )}
      {error && <small role="alert" className="profile-capacity-error">{error}</small>}
      {message && <small role="status">{message}</small>}
    </form>
  )
}
