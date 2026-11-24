import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  CalendarClock,
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  ListChecks,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import './listing-expiry.css'

type ApiFn = <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>
type Policy = { enabled: boolean; days: number; warning: boolean }
type Listing = {
  jobId: number
  accountLabel: string
  browserProfile: string
  vehicle: string
  state: string
  confirmedAt: string | null
  ageHours: number | null
  expiresAt: string | null
  canonicalUrl: string
  canExtend: boolean
}
type Overview = {
  policy: Policy
  canConfigure: boolean
  counts: { total: number; sold: number; expired: number; warning: number; review: number }
  items: Listing[]
  page: number
  pages: number
}

const labels: Record<string, string> = {
  sold: 'Vendido — retirar',
  expired: 'Vencido — retirar',
  review: 'Data a revisar',
  warning: 'Vence em até 24h',
  active: 'Dentro do prazo',
  disabled: 'Validade desativada',
}

function localDate(value: string | null) {
  return value ? new Date(value).toLocaleString('pt-BR') : 'Não confirmada'
}

const quickDays = [2, 4, 7, 10]
const extensionDays = [1, 2, 3, 7, 14, 30]

function dayLabel(days: number) {
  return days === 1 ? '1 dia' : days + ' dias'
}

function ageLabel(hours: number | null) {
  if (hours === null) return 'Idade desconhecida'
  const days = Math.floor(hours / 24)
  const remainder = hours % 24
  return days ? dayLabel(days) + (remainder ? ' e ' + remainder + 'h' : '') : hours + 'h'
}

function PolicyEditor({
  policy,
  busy,
  onSave,
}: {
  policy: Policy
  busy: boolean
  onSave: (policy: Policy) => void
}) {
  // Keyed by saved policy in the parent, not by polling results. Unsaved
  // edits survive the one-minute refresh while the stored policy is unchanged.
  const [enabled, setEnabled] = useState(policy.enabled)
  const [days, setDays] = useState(String(policy.days))
  const [warning, setWarning] = useState(policy.warning)
  const valid =
    days.trim() !== '' && Number.isInteger(Number(days)) && Number(days) >= 1 && Number(days) <= 90
  const dirty =
    enabled !== policy.enabled || Number(days) !== policy.days || warning !== policy.warning
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (valid && dirty && !busy) onSave({ enabled, days: Number(days), warning })
  }

  return (
    <form className="expiry-editor" onSubmit={submit}>
      <div className="expiry-editor-heading">
        <h3>Configurar validade</h3>
        <label className="expiry-switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span className="expiry-switch-track" aria-hidden="true" />
          <span>Controle ativo</span>
        </label>
      </div>
      <fieldset disabled={busy || !enabled}>
        <legend>Prazo padrão</legend>
        <div className="expiry-options">
          {quickDays.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={Number(days) === value}
              onClick={() => setDays(String(value))}
            >
              {dayLabel(value)}
            </button>
          ))}
          <label className="expiry-custom">
            <span>Outro</span>
            <input
              type="number"
              aria-label="Prazo personalizado em dias"
              min={1}
              max={90}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              required
            />
            <span>dias</span>
          </label>
        </div>
        <label className="expiry-switch">
          <input
            type="checkbox"
            checked={warning}
            onChange={(event) => setWarning(event.target.checked)}
          />
          <span className="expiry-switch-track" aria-hidden="true" />
          <span>Avisar no painel 24h antes</span>
        </label>
      </fieldset>
      <div className="expiry-save">
        <small>{dirty ? 'Alterações não salvas' : 'Configuração salva'}</small>
        <button className="primary" type="submit" disabled={busy || !valid || !dirty}>
          <Check size={16} />
          Salvar
        </button>
      </div>
    </form>
  )
}

export function ListingExpiryPanel({
  api,
  refreshVersion,
  onChanged,
}: {
  api: ApiFn
  refreshVersion: number
  onChanged: () => Promise<void>
}) {
  const [data, setData] = useState<Overview | null>(null)
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [extraDays, setExtraDays] = useState(3)

  useEffect(() => {
    let active = true
    let loading = false
    async function refresh() {
      if (loading) return
      loading = true
      try {
        const next = await api<Overview>('/publications/listing-expiry?page=' + page)
        if (active) setData(next)
      } catch (error) {
        if (active)
          setMessage(error instanceof Error ? error.message : 'Falha ao consultar validade.')
      } finally {
        loading = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [api, page, revision, refreshVersion])

  async function run(action: () => Promise<unknown>, success: string, changed = false) {
    setBusy(true)
    setMessage('')
    try {
      await action()
      setMessage(success)
      if (changed) await onChanged()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível concluir a operação.')
    } finally {
      setRevision((value) => value + 1)
      setBusy(false)
    }
  }

  function save(policy: Policy) {
    void run(
      () =>
        api('/publications/listing-expiry', {
          method: 'PATCH',
          body: JSON.stringify(policy),
        }),
      'Configuração de validade salva.',
    )
  }

  function confirmRemoved(item: Listing) {
    if (
      !window.confirm(
        'Confirme somente depois de excluir este anúncio no Facebook, usando o perfil ' +
          item.accountLabel +
          '. O Auto Flow não exclui o anúncio externo por este botão. Confirma que já foi retirado?',
      )
    )
      return
    void run(
      () =>
        api('/publications/' + item.jobId, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'removed' }),
        }),
      'Retirada registrada. O veículo e seu histórico foram preservados.',
      true,
    )
  }

  const metrics = [
    { label: 'Anúncios ativos', value: data?.counts.total, icon: ListChecks, tone: 'neutral' },
    { label: 'Vencendo em 24h', value: data?.counts.warning, icon: Clock3, tone: 'warning' },
    { label: 'Vencidos', value: data?.counts.expired, icon: CircleAlert, tone: 'danger' },
    { label: 'Vendidos a retirar', value: data?.counts.sold, icon: Check, tone: 'danger' },
    { label: 'Data a revisar', value: data?.counts.review, icon: CalendarClock, tone: 'neutral' },
  ]

  return (
    <section className="publication-workflow expiry-panel" aria-label="Validade dos anúncios">
      <div className="publication-workflow-heading">
        <div>
          <h2>Validade dos anúncios</h2>
          <p>Acompanhe o prazo de cada publicação e priorize as retiradas.</p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RotateCcw size={16} />
          Atualizar
        </button>
      </div>
      {message && (
        <p className="expiry-feedback" role="status">
          {message}
        </p>
      )}
      <div className="expiry-metrics">
        {metrics.map(({ label, value, icon: Icon, tone }) => (
          <div className={'expiry-metric expiry-tone-' + tone} key={label}>
            <Icon size={18} aria-hidden="true" />
            <div>
              <span>{label}</span>
              <strong>{value ?? '—'}</strong>
            </div>
          </div>
        ))}
      </div>
      {!data ? (
        <div className="expiry-empty">Consultando anúncios ativos...</div>
      ) : (
        <>
          <div className="expiry-policy-grid">
            <div className="expiry-rule">
              <div className="expiry-rule-heading">
                <span>Regra atual</span>
                <span className="expiry-rule-state">
                  {data.policy.enabled ? 'Ativa' : 'Desativada'}
                </span>
              </div>
              <div className="expiry-rule-value">
                <CalendarClock size={30} aria-hidden="true" />
                {data.policy.enabled ? (
                  <div>
                    <strong>{data.policy.days}</strong>
                    <span>{data.policy.days === 1 ? 'dia' : 'dias'} de validade</span>
                  </div>
                ) : (
                  <strong className="expiry-rule-off">Sem prazo ativo</strong>
                )}
              </div>
              <p>
                {data.policy.enabled
                  ? data.policy.days * 24 + ' horas após a publicação confirmada.'
                  : 'Anúncios vendidos continuam prioritários para retirada.'}
              </p>
              <div className="expiry-rule-detail">
                <Clock3 size={16} aria-hidden="true" />
                {data.policy.enabled && data.policy.warning
                  ? 'Aviso visual 24h antes'
                  : 'Sem aviso antecipado'}
              </div>
              <div className="expiry-rule-detail">
                <ShieldCheck size={16} aria-hidden="true" />
                Retirada supervisionada
              </div>
            </div>
            {data.canConfigure ? (
              <PolicyEditor
                key={JSON.stringify(data.policy)}
                policy={data.policy}
                busy={busy}
                onSave={save}
              />
            ) : (
              <div className="expiry-editor">
                <h3>Política de validade</h3>
                <p>Somente administradores podem alterar o prazo geral.</p>
              </div>
            )}
          </div>
          <div className="expiry-notice">
            <ShieldCheck size={17} aria-hidden="true" />
            <span>
              O Auto Flow sinaliza os vencimentos. Exclua o anúncio no perfil responsável antes de
              confirmar a retirada. Não há exclusão ou republicação automática por este painel.
            </span>
          </div>
          <div className="expiry-list-heading">
            <div>
              <h3>Anúncios monitorados</h3>
              <p>Ordenados por prioridade de retirada.</p>
            </div>
            {data.items.some((item) => item.canExtend) && (
              <label className="expiry-extension">
                <span>Prorrogar por</span>
                <select
                  aria-label="Prazo adicional de prorrogação"
                  value={extraDays}
                  disabled={busy}
                  onChange={(event) => setExtraDays(Number(event.target.value))}
                >
                  {extensionDays.map((days) => (
                    <option key={days} value={days}>
                      {dayLabel(days)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {data.items.length ? (
            <div className="expiry-table-wrap">
              <table className="expiry-table">
                <thead>
                  <tr>
                    <th>Veículo / perfil</th>
                    <th>Publicação / idade</th>
                    <th>Prazo / situação</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.jobId}>
                      <td>
                        <strong>{item.vehicle}</strong>
                        <small>
                          {item.accountLabel} · {item.browserProfile || 'Sem perfil identificado'}
                        </small>
                        <small>Trabalho #{item.jobId}</small>
                      </td>
                      <td>
                        <strong>{ageLabel(item.ageHours)}</strong>
                        <small>{localDate(item.confirmedAt)}</small>
                      </td>
                      <td>
                        <span className={'expiry-status expiry-state-' + item.state}>
                          {labels[item.state] || item.state}
                        </span>
                        <small>
                          {data.policy.enabled && item.expiresAt ? localDate(item.expiresAt) : '—'}
                        </small>
                      </td>
                      <td>
                        {item.canonicalUrl ? (
                          <a href={item.canonicalUrl} target="_blank" rel="noreferrer">
                            Abrir anúncio <ExternalLink size={13} />
                          </a>
                        ) : (
                          <small>Confira em Seus classificados no perfil indicado.</small>
                        )}
                        <div className="expiry-actions">
                          {item.canExtend && (
                            <button
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () =>
                                    api('/publications/' + item.jobId + '/extend-listing-expiry', {
                                      method: 'PATCH',
                                      body: JSON.stringify({ days: extraDays }),
                                    }),
                                  'Validade prorrogada.',
                                )
                              }
                            >
                              Prorrogar
                            </button>
                          )}
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() => confirmRemoved(item)}
                          >
                            Confirmar retirada
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="expiry-empty">
              <ListChecks size={28} aria-hidden="true" />
              <strong>Nenhum anúncio ativo no momento</strong>
              <p>As publicações confirmadas aparecerão aqui com a idade e a data de vencimento.</p>
            </div>
          )}
          {data.pages > 1 && (
            <div className="expiry-pagination">
              <button
                className="secondary"
                disabled={data.page <= 1 || busy}
                onClick={() => setPage(data.page - 1)}
              >
                Anterior
              </button>
              <span>
                {data.page} / {data.pages}
              </span>
              <button
                className="secondary"
                disabled={data.page >= data.pages || busy}
                onClick={() => setPage(data.page + 1)}
              >
                Próxima
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
