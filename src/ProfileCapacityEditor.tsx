import { useEffect, useState } from 'react'
import './profile-capacity.css'

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
    setMinutes(
      result.intervalMinutesOverride === null ? '' : String(result.intervalMinutesOverride),
    )
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
        if (active)
          setError(cause instanceof Error ? cause.message : 'Falha ao consultar capacidade.')
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

  if (!capacity)
    return (
      <small className="profile-capacity-loading" role="status">
        {error || 'Carregando limites operacionais…'}
      </small>
    )

  return (
    <form
      className="profile-capacity"
      onSubmit={(event) => void save(event)}
      aria-label="Limites operacionais do perfil"
    >
      <div className="profile-capacity-heading">
        <div className="profile-capacity-intro">
          <h3>Capacidade do perfil</h3>
          <p>Defina os limites de execução deste perfil.</p>
        </div>
        <div className="profile-capacity-today" aria-label="Atividade do perfil hoje">
          <div className="profile-capacity-metric">
            <strong>
              {capacity.used} <span>de {capacity.dailyLimit}</span>
            </strong>
            <span>Execuções hoje</span>
          </div>
          <div className="profile-capacity-metric">
            <strong>{capacity.queuedToday}</strong>
            <span>Trabalhos criados hoje</span>
          </div>
        </div>
      </div>
      <div className="profile-capacity-fields">
        <label className="profile-capacity-field">
          Limite diário
          <input
            type="number"
            min="1"
            max={capacity.organizationDailyLimit}
            value={daily}
            placeholder={String(capacity.organizationDailyLimit)}
            onChange={(event) => setDaily(event.target.value)}
            disabled={loading}
          />
          <span className="profile-capacity-hint">
            Padrão da empresa: {capacity.organizationDailyLimit} por dia
          </span>
        </label>
        <label className="profile-capacity-field">
          Intervalo entre execuções (min)
          <input
            type="number"
            min="0"
            max="1440"
            value={minutes}
            placeholder={String(capacity.organizationIntervalMinutes)}
            onChange={(event) => setMinutes(event.target.value)}
            disabled={loading}
          />
          <span className="profile-capacity-hint">
            Padrão da empresa: {capacity.organizationIntervalMinutes} min
          </span>
        </label>
      </div>
      <div className="profile-capacity-footer">
        <p className="profile-capacity-note">
          Deixe um campo vazio para usar o padrão da empresa. Estes são limites internos, não regras
          oficiais da plataforma.
        </p>
        <button type="submit" className="secondary" disabled={loading}>
          {loading ? 'Salvando...' : 'Salvar limites'}
        </button>
      </div>
      {capacity.nextAllowedAt && (
        <p className="profile-capacity-next-run">
          Próxima execução possível após {new Date(capacity.nextAllowedAt).toLocaleString('pt-BR')}.
        </p>
      )}
      {error && (
        <p role="alert" className="profile-capacity-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="profile-capacity-success">
          {message}
        </p>
      )}
    </form>
  )
}
