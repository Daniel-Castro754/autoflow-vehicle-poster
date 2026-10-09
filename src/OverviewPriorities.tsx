import { useEffect, useState } from 'react'
import { AlertTriangle, Camera, CheckCircle2, ChevronRight, ClipboardList, Send } from 'lucide-react'

type VehicleSummary = { id: number; status: string; imageCount?: number }
type Insight = { totals: { open: number; acknowledged: number; critical: number } }
type Api = <T>(path: string, options?: RequestInit) => Promise<T>

export function OverviewPriorities({
  api,
  vehicles,
  navigate,
  onOpenMonitoring,
}: {
  api: Api
  vehicles: VehicleSummary[]
  navigate: (page: string) => void
  onOpenMonitoring: () => void
}) {
  const [incidents, setIncidents] = useState<Insight['totals'] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        const result = await api<Insight>('/operations/incidents?status=active&limit=1')
        if (alive) {
          setIncidents(result.totals)
          setFailed(false)
        }
      } catch {
        if (alive) setFailed(true)
      } finally {
        if (alive) timer = setTimeout(() => void refresh(), 30_000)
      }
    }
    void refresh()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api])

  const noPhotos = vehicles.filter((vehicle) => vehicle.imageCount === 0 && vehicle.status !== 'Vendido').length
  const attention = vehicles.filter((vehicle) => vehicle.status === 'Atenção').length
  const ready = vehicles.filter((vehicle) => vehicle.status === 'Pronto').length
  const openIncidents = (incidents?.open || 0) + (incidents?.acknowledged || 0)
  const critical = incidents?.critical || 0

  const priorities = [
    ...(critical > 0
      ? [{
          id: 'critical',
          tone: 'danger',
          icon: AlertTriangle,
          title: `${critical} ocorrência${critical === 1 ? '' : 's'} crítica${critical === 1 ? '' : 's'}`,
          detail: 'Verifique publicações incertas antes de qualquer nova tentativa.',
          action: 'Revisar',
          onClick: onOpenMonitoring,
        }]
      : []),
    ...(attention > 0
      ? [{
          id: 'attention',
          tone: 'danger',
          icon: ClipboardList,
          title: `${attention} veículo${attention === 1 ? '' : 's'} requer${attention === 1 ? '' : 'em'} revisão`,
          detail: 'Confira dados e pendências do estoque.',
          action: 'Ver veículos',
          onClick: () => navigate('Veículos'),
        }]
      : []),
    ...(noPhotos > 0
      ? [{
          id: 'photos',
          tone: 'warning',
          icon: Camera,
          title: `${noPhotos} veículo${noPhotos === 1 ? '' : 's'} sem fotos`,
          detail: 'Inclua as imagens antes de preparar os anúncios.',
          action: 'Adicionar fotos',
          onClick: () => navigate('Veículos'),
        }]
      : []),
    ...(openIncidents > critical
      ? [{
          id: 'incidents',
          tone: 'warning',
          icon: AlertTriangle,
          title: `${openIncidents - critical} outra${openIncidents - critical === 1 ? '' : 's'} ocorrência${openIncidents - critical === 1 ? '' : 's'} ativa${openIncidents - critical === 1 ? '' : 's'}`,
          detail: 'Consulte o histórico das execuções no monitoramento.',
          action: 'Monitorar',
          onClick: onOpenMonitoring,
        }]
      : []),
    ...(ready > 0
      ? [{
          id: 'ready',
          tone: 'info',
          icon: Send,
          title: `${ready} veículo${ready === 1 ? '' : 's'} pronto${ready === 1 ? '' : 's'}`,
          detail: 'Consulte a fila e confira os requisitos de publicação.',
          action: 'Abrir fila',
          onClick: () => navigate('Publicações'),
        }]
      : []),
  ]

  return (
    <section className="overview-priorities" aria-label="Ações e prioridades">
      <div className="overview-section-heading">
        <div>
          <span className="page-kicker">SUAS PRIORIDADES</span>
          <h2>Ações necessárias</h2>
          <p>O que merece atenção antes da próxima publicação.</p>
        </div>
        <span className="overview-priority-counter">
          {priorities.length} {priorities.length === 1 ? 'assunto' : 'assuntos'}
        </span>
      </div>
      {failed && (
        <p className="overview-priority-error" role="status">
          Não foi possível consultar as ocorrências. Confira o monitoramento antes de publicar.
        </p>
      )}
      {priorities.length === 0 ? (
        <div className="overview-empty-state">
          <CheckCircle2 size={19} />
          <span>Nenhuma prioridade identificada nos dados disponíveis.</span>
        </div>
      ) : (
        <div className="overview-priority-list">
          {priorities.map((item) => {
            const Icon = item.icon
            return (
              <div key={item.id} className={`overview-priority-item tone-${item.tone}`}>
                <span className="overview-priority-icon"><Icon size={19} /></span>
                <div className="overview-priority-copy">
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </div>
                <button type="button" onClick={item.onClick}>
                  {item.action} <ChevronRight size={16} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
