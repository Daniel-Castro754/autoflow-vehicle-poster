import { useEffect, useState } from 'react'
import { Check, Images, RefreshCw, ShieldCheck } from 'lucide-react'
import './photo-curation.css'

type Api = <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>
type Image = {
  id: number
  originalName: string
  category: string
  url: string
}
type Curation = {
  images: Image[]
  recommendation: number[]
  preferredCount: number
  fingerprint: string
  enabled: boolean
  approved: boolean
  needsReview: boolean
  selectedIds: number[]
}
const CATEGORIES = [
  ['front', 'Frente'],
  ['side', 'Lateral'],
  ['rear', 'Traseira'],
  ['interior', 'Interior'],
  ['dashboard', 'Painel'],
  ['engine', 'Motor'],
  ['detail', 'Detalhes'],
  ['other', 'Outro'],
] as const

export function PhotoCurationPanel({
  api,
  vehicleId,
  photoVersion,
}: {
  api: Api
  vehicleId: number
  photoVersion: string
}) {
  const [data, setData] = useState<Curation | null>(null)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function refresh() {
    const state = await api<Curation>('/vehicles/' + vehicleId + '/photos/curation')
    setData(state)
    setSelectedIds(state.approved ? state.selectedIds : state.recommendation)
  }

  useEffect(() => {
    let live = true
    void api<Curation>('/vehicles/' + vehicleId + '/photos/curation')
      .then((state) => {
        if (!live) return
        setData(state)
        setSelectedIds(state.approved ? state.selectedIds : state.recommendation)
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : 'Erro ao carregar fotos.')
      })
    return () => {
      live = false
    }
  }, [api, vehicleId, photoVersion])

  async function run(work: () => Promise<void>) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await work()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar as fotos.')
    } finally {
      setBusy(false)
    }
  }

  function togglePhoto(id: number, checked: boolean) {
    setSelectedIds((current) =>
      checked ? [...current, id].slice(0, 20) : current.filter((item) => item !== id),
    )
  }
  function setCover(id: number) {
    setSelectedIds((current) => [id, ...current.filter((item) => item !== id)])
  }

  if (!data || !data.images.length) return null

  const selected = selectedIds
    .map((id) => data.images.find((image) => image.id === id))
    .filter((image): image is Image => Boolean(image))

  return (
    <section className="photo-curation-panel" aria-label="Curadoria de fotografias">
      <div className="photo-curation-heading">
        <Images size={17} />
        <strong>Curadoria de fotos</strong>
        <span>{selectedIds.length} selecionadas</span>
      </div>
      <p>
        Sugestão de até 8 fotos reais, priorizando diferentes ângulos quando categorizados.
        Selecione a capa e confirme antes de alterar as fotos enviadas.
      </p>
      {data.approved && !data.needsReview && (
        <p className="photo-curation-status">
          <ShieldCheck size={15} />
          Seleção aprovada para a publicação.
        </p>
      )}
      {data.needsReview && (
        <p className="photo-curation-warning" role="status">
          As imagens ou categorias mudaram. A publicação ficará bloqueada até nova aprovação.
        </p>
      )}
      <div className="photo-curation-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => setSelectedIds(data.recommendation)}
        >
          <RefreshCw size={14} /> Sugerir {data.preferredCount}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => setSelectedIds(data.images.map((image) => image.id))}
        >
          Selecionar todas
        </button>
      </div>
      <div className="photo-curation-items">
        {data.images.map((image) => (
          <div className="photo-curation-item" key={image.id}>
            <img src={image.url} alt={image.originalName} />
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(image.id)}
                  disabled={busy}
                  onChange={(event) => togglePhoto(image.id, event.target.checked)}
                />
                <span>{image.originalName}</span>
              </label>
              <label className="photo-curation-cover">
                <input
                  type="radio"
                  name="photo-cover"
                  checked={selectedIds[0] === image.id}
                  disabled={busy || !selectedIds.includes(image.id)}
                  onChange={() => setCover(image.id)}
                />
                Capa
              </label>
              <select
                aria-label={'Categoria de ' + image.originalName}
                value={image.category}
                disabled={busy}
                onChange={(event) =>
                  void run(async () => {
                    await api('/vehicles/' + vehicleId + '/photos/' + image.id + '/category', {
                      method: 'PATCH',
                      body: JSON.stringify({ category: event.target.value }),
                    })
                    await refresh()
                    setMessage('Categoria atualizada. Revise a seleção antes de aprovar.')
                  })
                }
              >
                {CATEGORIES.map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>
      <div className="photo-curation-preview">
        <strong>Ordem da publicação</strong>
        <p>
          {selected
            .map((photo, index) => (index === 0 ? 'Capa: ' : '') + photo.originalName)
            .join(' → ') || 'Nenhuma foto selecionada.'}
        </p>
      </div>
      {error && (
        <p className="photo-curation-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="photo-curation-status" role="status">
          <Check size={15} />
          {message}
        </p>
      )}
      <div className="photo-curation-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !selectedIds.length}
          onClick={() =>
            void run(async () => {
              await api('/vehicles/' + vehicleId + '/photos/selection', {
                method: 'POST',
                body: JSON.stringify({ photoIds: selectedIds, fingerprint: data.fingerprint }),
              })
              await refresh()
              setMessage('Seleção de fotos aprovada.')
            })
          }
        >
          <Check size={15} /> Aprovar seleção
        </button>
        {data.enabled && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api('/vehicles/' + vehicleId + '/photos/selection', { method: 'DELETE' })
                await refresh()
                setMessage('Curadoria desativada. O fluxo anterior envia as fotos cadastradas.')
              })
            }
          >
            Usar todas (modo anterior)
          </button>
        )}
      </div>
      <small>Não são criadas fotos artificiais. O sistema mantém os originais e seus hashes.</small>
    </section>
  )
}
