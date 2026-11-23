import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

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
        if (active) setMessage(error instanceof Error ? error.message : 'Falha ao consultar validade.')
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

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void run(
      () =>
        api('/publications/listing-expiry', {
          method: 'PATCH',
          body: JSON.stringify({
            enabled: form.has('enabled'),
            days: Number(form.get('days')),
            warning: form.has('warning'),
          }),
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

  return (
    <section className="publication-workflow" aria-label="Validade dos anúncios">
      <div className="publication-workflow-heading">
        <div>
          <h2>Validade dos anúncios</h2>
          <p>Controle a idade dos anúncios confirmados e retire os vencidos no Facebook.</p>
        </div>
        <button className="secondary" onClick={() => setRevision((value) => value + 1)}>
          Atualizar
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {!data ? (
        <p>Consultando anúncios ativos...</p>
      ) : (
        <>
          <p>
            {data.counts.total} ativos · {data.counts.sold} vendidos · {data.counts.expired} vencidos
            · {data.counts.warning} vencendo · {data.counts.review} com data a revisar
          </p>
          {data.canConfigure && (
            <form
              key={JSON.stringify(data.policy)}
              onSubmit={save}
              style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <label>
                <input type="checkbox" name="enabled" defaultChecked={data.policy.enabled} />{' '}
                Controlar validade
              </label>
              <label>
                Prazo (dias){' '}
                <input
                  type="number"
                  name="days"
                  min={1}
                  max={90}
                  required
                  defaultValue={data.policy.days}
                  style={{ width: 85 }}
                />
              </label>
              <label>
                <input type="checkbox" name="warning" defaultChecked={data.policy.warning} />{' '}
                Avisar 24h antes
              </label>
              <button className="secondary" disabled={busy} type="submit">
                Salvar validade
              </button>
            </form>
          )}
          <p>
            Prazo atual: {data.policy.enabled ? data.policy.days + ' dias' : 'desativado'}. O sistema
            não exclui nem republica automaticamente. Retire o anúncio pelo perfil indicado antes
            de registrar a retirada.
          </p>
          <label>
            Prorrogação (dias){' '}
            <select value={extraDays} onChange={(event) => setExtraDays(Number(event.target.value))}>
              {[1, 2, 3, 7, 14, 30].map((days) => (
                <option key={days} value={days}>
                  {days}
                </option>
              ))}
            </select>
          </label>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%' }}>
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
                      <div>
                        {item.accountLabel} · {item.browserProfile || 'Sem perfil identificado'}
                      </div>
                      <small>Trabalho #{item.jobId}</small>
                    </td>
                    <td>
                      {localDate(item.confirmedAt)}
                      <div>{item.ageHours === null ? '—' : item.ageHours + 'h'}</div>
                    </td>
                    <td>
                      <strong>{labels[item.state] || item.state}</strong>
                      <div>{data.policy.enabled ? localDate(item.expiresAt) : '—'}</div>
                    </td>
                    <td>
                      {item.canonicalUrl ? (
                        <a href={item.canonicalUrl} target="_blank" rel="noreferrer">
                          Abrir anúncio
                        </a>
                      ) : (
                        <small>Confira em Seus classificados no perfil indicado.</small>
                      )}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
          {!data.items.length && <p>Nenhum anúncio ativo registrado.</p>}
          {data.pages > 1 && (
            <div>
              <button disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
                Anterior
              </button>{' '}
              {data.page} / {data.pages}{' '}
              <button disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>
                Próxima
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
