import { useState } from 'react'
import { Check, FileText, Loader2, ShieldCheck } from 'lucide-react'
import './listing-variants.css'

type Variant = { id: number; title: string; description: string }
type Preview = {
  previewId: string
  expiresInMinutes: number
  style: 'balanced'
  requiresApproval: true
  variants: Variant[]
}
type Api = <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>

export function ListingVariantsPanel({
  api,
  vehicleId,
  onApproved,
}: {
  api: Api
  vehicleId: number
  onApproved: () => Promise<void>
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function generate() {
    setBusy(true)
    setError('')
    setPreview(null)
    try {
      const result = await api<Preview>('/ai/listing-text/preview', {
        method: 'POST',
        body: JSON.stringify({ vehicleId }),
      })
      setSelected(result.variants[0]?.id || 1)
      setPreview(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível gerar as opções.')
    } finally {
      setBusy(false)
    }
  }

  async function approve() {
    if (!preview) return
    setBusy(true)
    setError('')
    try {
      await api('/ai/listing-text/approve', {
        method: 'POST',
        body: JSON.stringify({ previewId: preview.previewId, variantId: selected }),
      })
      setPreview(null)
      await onApproved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível aprovar a descrição.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="listing-variants-panel" aria-label="Variações de texto do anúncio">
      <div className="listing-variants-heading">
        <FileText size={17} />
        <strong>Variações de texto</strong>
        <span>Estilo equilibrado</span>
      </div>
      <p>
        Gere opções a partir dos dados salvos do veículo. Nenhuma informação é alterada sem
        aprovação. Salve eventuais edições no formulário antes de gerar a prévia.
      </p>
      <button type="button" className="secondary" onClick={() => void generate()} disabled={busy}>
        {busy ? <Loader2 size={15} /> : <FileText size={15} />}
        {busy ? 'Processando...' : preview ? 'Gerar novas opções' : 'Gerar 3 opções'}
      </button>
      {error && (
        <p className="listing-variants-error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <div className="listing-variants-choices">
          <p className="listing-variants-note">
            <ShieldCheck size={15} />
            Escolha uma opção. A prévia expira em {preview.expiresInMinutes} minutos. O título
            apresentado é uma sugestão; o Marketplace continua usando os campos do veículo.
          </p>
          {preview.variants.map((variant) => (
            <label key={variant.id} className="listing-variant-choice">
              <span className="listing-variant-select">
                <input
                  type="radio"
                  name="listing-text-choice"
                  checked={selected === variant.id}
                  onChange={() => setSelected(variant.id)}
                  disabled={busy}
                />
                <strong>Versão {variant.id}</strong>
              </span>
              <span className="listing-variant-title">{variant.title}</span>
              <span className="listing-variant-description">{variant.description}</span>
            </label>
          ))}
          <button type="button" className="primary" onClick={() => void approve()} disabled={busy}>
            <Check size={16} />
            Aprovar e aplicar descrição selecionada
          </button>
          <small>Somente esta aprovação grava o texto no estoque. Não cria publicação.</small>
        </div>
      )}
    </section>
  )
}
