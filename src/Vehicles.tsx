import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Car,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Edit3,
  ImagePlus,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { FieldLabel, HelpTip } from './HelpTip'
import { DrawerFocusGuard } from './DrawerFocusGuard'
import {
  BODY_TYPES,
  FUEL_TYPES,
  TRANSMISSIONS,
  VEHICLE_COLORS,
  VEHICLE_CONDITIONS,
  VEHICLE_MAKES,
  VEHICLE_STATUSES,
  VEHICLE_TYPES,
  VEHICLE_YEARS,
  withLegacyOption,
} from './vehicleOptions'

type ApiFn = <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>
type AccountOption = {
  id: number
  label: string
  browserProfile?: string
  automationPaused?: number
  automationPauseReason?: string
}
type MenuState = { vehicleId: number; top: number; left: number }
type VehiclePage = {
  vehicles: VehicleRecord[]
  pagination: { totalItems: number; totalPages: number; currentPage: number; pageSize: number }
}
type VehicleSummary = {
  total: number
  published: number
  readyStatus: number
  attention: number
  noPhotos?: number
}

export type VehicleRecord = {
  id: number
  year: number
  make: string
  model: string
  trim: string
  price: number
  km: number
  stockCode?: string
  vin?: string
  seller: string
  initials: string
  status: 'Pronto' | 'Publicado' | 'Rascunho' | 'Atenção' | 'Vendido'
  color: string
  updatedAt?: string
  vehicleType?: string
  location?: string
  transmission?: string
  fuelType?: string
  bodyType?: string
  condition?: string
  exteriorColor?: string
  interiorColor?: string
  description?: string
  imageCount?: number
  thumbnailUrl?: string
  soldAt?: string
  pendingRemovalCount?: number
}

type ImageRecord = { id: number; originalName: string; url: string; mimeType: string }
type ImportSummary = {
  total: number
  created: number
  updated: number
  skipped: number
  failed: number
  photos?: number
  previewDigest?: string
  photoRows?: Array<{
    row: number
    stockCode: string
    label: string
    images: number
    action: string
  }>
  errors: Array<{ row: number; error: string }>
}
type ZipPreview = { zipBase64: string; mode: 'skip' | 'update'; summary: ImportSummary }
const money = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

function Badge({ status }: { status: VehicleRecord['status'] }) {
  const icon =
    status === 'Publicado' ? (
      <Check size={13} />
    ) : status === 'Atenção' ? (
      <CircleAlert size={13} />
    ) : status === 'Rascunho' ? (
      <Clock3 size={13} />
    ) : status === 'Vendido' ? (
      <Tag size={13} />
    ) : (
      <span className="dot" />
    )
  return (
    <span
      className={`badge ${status
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')}`}
    >
      {icon}
      {status}
    </span>
  )
}

function Thumb({ vehicle }: { vehicle: VehicleRecord }) {
  return (
    <div className="car-thumb" style={{ background: vehicle.color }}>
      {vehicle.thumbnailUrl ? (
        <img src={vehicle.thumbnailUrl} alt="" />
      ) : (
        <Car size={30} strokeWidth={1.4} />
      )}
      {Boolean(vehicle.imageCount) && <span className="photo-count">{vehicle.imageCount}</span>}
    </div>
  )
}

async function filePayload(file: File) {
  if (file.size > 12 * 1024 * 1024) throw new Error(`${file.name} excede o limite de 12 MB.`)
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  return { name: file.name, mimeType: file.type, dataBase64 }
}

export default function VehiclesView({
  api,
  vehicles,
  accounts,
  reload,
  notify,
  refreshVersion,
}: {
  api: ApiFn
  refreshVersion: number
  vehicles: VehicleRecord[]
  accounts: AccountOption[]
  reload: () => Promise<void>
  notify: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('Todos')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editor, setEditor] = useState<VehicleRecord | null | undefined>(undefined)
  const [queueVehicle, setQueueVehicle] = useState<VehicleRecord | null>(null)
  const [pageVehicles, setPageVehicles] = useState<VehicleRecord[]>(vehicles.slice(0, 25))
  const [page, setPage] = useState(1)
  const [pageLoading, setPageLoading] = useState(true)
  const [pagination, setPagination] = useState({
    totalItems: vehicles.length,
    totalPages: Math.max(1, Math.ceil(vehicles.length / 25)),
    currentPage: 1,
    pageSize: 25,
  })
  const [summary, setSummary] = useState<VehicleSummary | null>(null)
  const [importing, setImporting] = useState(false)
  const [packagePreview, setPackagePreview] = useState<ZipPreview | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [importingPhotos, setImportingPhotos] = useState(false)
  const deferredQuery = useDeferredValue(query)

  function changeStatusFilter(next: string) {
    setStatus(next)
    setPage(1)
    setPageLoading(true)
    setSelected(new Set())
  }

  useEffect(() => {
    let active = true
    const params = new URLSearchParams({
      page: String(page),
      limit: '25',
      query: deferredQuery,
      status,
    })
    void Promise.all([
      api<VehiclePage>(`/vehicles/paged?${params}`),
      api<VehicleSummary>('/vehicles/summary'),
    ])
      .then(([result, counts]) => {
        if (!active) return
        setPageVehicles(result.vehicles)
        setPagination(result.pagination)
        setSummary(counts)
        if (result.pagination.currentPage !== page) setPage(result.pagination.currentPage)
      })
      .catch((error) => {
        if (active) notify(error instanceof Error ? error.message : 'Erro ao carregar veículos')
      })
      .finally(() => {
        if (active) setPageLoading(false)
      })
    return () => {
      active = false
    }
  }, [api, deferredQuery, status, page, refreshVersion, notify])

  const filtered = pageVehicles
  const allSelected = filtered.length > 0 && filtered.every((vehicle) => selected.has(vehicle.id))
  const menuVehicle = menu
    ? pageVehicles.find((vehicle) => vehicle.id === menu.vehicleId)
    : undefined

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(filtered.map((vehicle) => vehicle.id)))
  }

  function toggleOne(id: number) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleMenu(event: React.MouseEvent<HTMLButtonElement>, vehicleId: number) {
    event.stopPropagation()
    if (menu?.vehicleId === vehicleId) return setMenu(null)
    const rect = event.currentTarget.getBoundingClientRect()
    const width = 238
    const estimatedHeight = 174
    const left = Math.max(10, Math.min(window.innerWidth - width - 10, rect.right - width))
    const top =
      rect.bottom + estimatedHeight + 8 > window.innerHeight
        ? Math.max(10, rect.top - estimatedHeight - 8)
        : rect.bottom + 8
    setMenu({ vehicleId, top, left })
  }

  async function remove(ids: number[]) {
    if (
      !ids.length ||
      !window.confirm(
        `Excluir ${ids.length} veículo${ids.length > 1 ? 's' : ''}? Fotos e publicações relacionadas também serão removidas.`,
      )
    )
      return
    try {
      const result = await api<{ deleted: number }>('/vehicles', {
        method: 'DELETE',
        body: JSON.stringify({ ids }),
      })
      setSelected(new Set())
      setMenu(null)
      notify(
        `${result.deleted} veículo${result.deleted === 1 ? '' : 's'} excluído${result.deleted === 1 ? '' : 's'}.`,
      )
      await reload()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Erro ao excluir veículos')
    }
  }

  async function markSold(vehicleId: number) {
    setMenu(null)
    try {
      const result = await api<{ reviewJobs: number }>(`/vehicles/${vehicleId}/mark-sold`, {
        method: 'POST',
      })
      notify(
        result.reviewJobs
          ? 'Veículo vendido. Há publicações em andamento para conferir no Facebook; revise em Publicações.'
          : 'Veículo vendido. Trabalhos pendentes foram cancelados; remova os anúncios que já estavam publicados.',
      )
      await reload()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Erro ao marcar veículo como vendido')
    }
  }


  async function importVehiclePhotos(selectedFiles?: FileList | null) {
    if (!selectedFiles?.length) return
    // Require an explicit stock code to avoid attaching photos to the wrong car.
    const files = Array.from(selectedFiles)
    const parseName = (name: string) => {
      const match = name.match(/^([A-Za-z0-9._-]+)__(\d{1,2})\.(jpg|jpeg|png|webp)$/i)
      return match ? { code: match[1].toUpperCase(), order: Number(match[2]) } : null
    }
    const invalid = files.filter((file) => !parseName(file.name))
    if (invalid.length) {
      notify('Use o padrão CODIGO__01.jpg para cada foto. Arquivos com nome inválido: ' + invalid.length)
      return
    }
    setImportingPhotos(true)
    try {
      const stock = await api<{ vehicles: VehicleRecord[] }>('/vehicles')
      const byCode = new Map<string, VehicleRecord>()
      for (const vehicle of stock.vehicles) {
        if (vehicle.stockCode) byCode.set(vehicle.stockCode.toUpperCase(), vehicle)
      }
      const groups = new Map<number, Array<{ file: File; order: number }>>()
      const unmatched = new Set<string>()
      for (const file of files) {
        const parsed = parseName(file.name)!
        const vehicle = byCode.get(parsed.code)
        if (!vehicle) {
          unmatched.add(parsed.code)
          continue
        }
        const group = groups.get(vehicle.id) || []
        group.push({ file, order: parsed.order })
        groups.set(vehicle.id, group)
      }
      const planned = [...groups.entries()].reduce((total, [id, images]) => {
        const count = stock.vehicles.find((v) => v.id === id)?.imageCount || 0
        return total + Math.min(images.length, Math.max(0, 20 - count))
      }, 0)
      if (!planned) {
        notify('Nenhuma foto corresponde a um código de estoque com espaço disponível.')
        return
      }
      if (!window.confirm(
        'Importar até ' + planned + ' foto(s) para ' + groups.size +
        ' veículo(s)?\nCódigos não encontrados: ' + unmatched.size +
        '.\nFotos existentes serão preservadas.',
      )) return
      let uploaded = 0
      let duplicates = 0
      let failures = 0
      for (const [vehicleId, images] of groups) {
        const vehicle = stock.vehicles.find((v) => v.id === vehicleId)!
        let remaining = Math.max(0, 20 - (vehicle.imageCount || 0))
        for (const { file } of images.sort((a, b) => a.order - b.order)) {
          if (!remaining) break
          try {
            const response = await api<{ duplicate?: boolean }>(`/vehicles/${vehicleId}/images`, {
              method: 'POST',
              body: JSON.stringify(await filePayload(file)),
            })
            if (response.duplicate) duplicates++
            else {
              uploaded++
              remaining--
            }
          } catch {
            failures++
          }
        }
      }
      notify('Fotos: ' + uploaded + ' adicionada(s), ' + duplicates +
        ' duplicada(s), ' + failures + ' falha(s), ' + unmatched.size + ' código(s) não localizado(s).')
      await reload()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível importar as fotos.')
    } finally {
      setImportingPhotos(false)
      if (photoInputRef.current) photoInputRef.current.value = ''
    }
  }

  async function importCsv(file?: File) {
    if (!file) return
    const isZip = file.name.toLowerCase().endsWith('.zip')
    if (!isZip && !file.name.toLowerCase().endsWith('.csv')) {
      notify('Selecione um arquivo CSV ou ZIP.')
      return
    }
    if (file.size > (isZip ? 48 : 2) * 1024 * 1024) {
      notify(isZip ? 'O ZIP deve ter no máximo 48 MB.' : 'O CSV deve ter no máximo 2 MB.')
      return
    }
    const mode = window.confirm(
      'Deseja atualizar veículos existentes quando o ID de estoque ou VIN já estiver cadastrado?\n\nOK = atualizar existentes\nCancelar = importar somente novos',
    )
      ? 'update'
      : 'skip'
    setImporting(true)
    try {
      const zipBase64 = isZip
        ? await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
            reader.onerror = () => reject(reader.error || new Error('Não foi possível ler o ZIP.'))
            reader.readAsDataURL(file)
          })
        : ''
      const csv = isZip ? '' : await file.text()
      const preview = await api<ImportSummary>('/vehicles/import', {
        method: 'POST',
        body: JSON.stringify(
          isZip ? { zipBase64, mode, dryRun: true } : { csv, mode, dryRun: true },
        ),
      })
      if (isZip) {
        if (!preview.previewDigest) throw new Error('Não foi possível validar a prévia do ZIP.')
        setPackagePreview({ zipBase64, mode, summary: preview })
        return
      }
      const proceed = window.confirm(
        [
          'PRÉVIA — nenhuma alteração foi gravada.',
          `Total: ${preview.total} | Novos: ${preview.created} | Atualizações: ${preview.updated}`,
          `Ignorados: ${preview.skipped} | Erros: ${preview.failed}`,
          preview.failed ? 'Há linhas com erro, que serão ignoradas.' : '',
          'Confirmar sincronização do estoque com estes resultados?',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      if (!proceed) {
        notify('Sincronização cancelada: nenhuma alteração realizada.')
        return
      }
      const result = await api<ImportSummary>('/vehicles/import', {
        method: 'POST',
        body: JSON.stringify({ csv, mode, previewDigest: preview.previewDigest }),
      })
      notify(
        `CSV processado: ${result.created} novo(s), ${result.updated} atualizado(s), ${result.skipped} ignorado(s), ${result.failed} com erro.`,
      )
      if (result.errors.length) {
        window.alert(
          [
            'Linhas que precisam de revisão:',
            ...result.errors.slice(0, 12).map((item) => `Linha ${item.row}: ${item.error}`),
          ].join('\n'),
        )
      }
      setPage(1)
      await reload()
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Erro ao importar CSV')
    } finally {
      setImporting(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  async function confirmPackageImport() {
    if (!packagePreview || importing) return
    setImporting(true)
    try {
      const result = await api<ImportSummary>('/vehicles/import', {
        method: 'POST',
        body: JSON.stringify({
          zipBase64: packagePreview.zipBase64,
          mode: packagePreview.mode,
          previewDigest: packagePreview.summary.previewDigest,
        }),
      })
      setPackagePreview(null)
      notify(
        `Pacote importado: ${result.created} novos, ${result.updated} atualizados, ${result.photos || 0} fotos, ${result.skipped} ignorados, ${result.failed} erros.`,
      )
      if (result.errors.length)
        window.alert(
          result.errors
            .slice(0, 15)
            .map((item) => `Linha ${item.row}: ${item.error}`)
            .join('\n'),
        )
      setPage(1)
      await reload()
    } catch (error) {
      setPackagePreview(null)
      notify(error instanceof Error ? error.message : 'Falha na importação. Gere uma nova prévia.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <section className="content vehicles-page">
      <div className="title-row">
        <div>
          <span className="page-kicker">GESTÃO DE ESTOQUE</span>
          <h1>Veículos</h1>
          <p>Consulte os registros, corrija pendências e prepare os anúncios.</p>
        </div>
        <div className="title-actions">
          <input
            ref={importInputRef}
            type="file"
            accept=".csv,.zip,text/csv,application/zip"
            hidden
            onChange={(event) => void importCsv(event.target.files?.[0])}
          />
          <button
            className="secondary"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
          >
            <Upload size={18} />
            {importing ? 'Processando...' : 'Importar CSV ou ZIP'}
          </button>
          <input
            ref={photoInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            multiple
            hidden
            onChange={(event) => void importVehiclePhotos(event.target.files)}
          />
          <button
            className="secondary"
            onClick={() => photoInputRef.current?.click()}
            disabled={importing || importingPhotos}
            title="Associe fotos pelo código de estoque: CODIGO__01.jpg"
          >
            <ImagePlus size={18} />
            {importingPhotos ? 'Importando fotos...' : 'Importar fotos'}
          </button>
          <div className="action-with-help">
            <button className="primary" onClick={() => setEditor(null)}>
              <Plus size={18} />
              Adicionar veículo
            </button>
            <HelpTip
              text="Cadastre todos os dados e as fotos antes de colocar o veículo na fila de publicação."
              placement="bottom"
            />
          </div>
        </div>
      </div>
      {packagePreview &&
        createPortal(
          <div
            className="overlay package-import-overlay"
            onMouseDown={() => !importing && setPackagePreview(null)}
          >
            <aside
              className="drawer package-import-drawer"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <DrawerFocusGuard
                label="Prévia de importação de veículos com fotos"
                onClose={() => !importing && setPackagePreview(null)}
              />
              <button
                className="close"
                type="button"
                aria-label="Fechar prévia"
                disabled={importing}
                onClick={() => setPackagePreview(null)}
              >
                <X size={20} />
              </button>
              <span className="page-kicker">IMPORTAÇÃO EM LOTE</span>
              <h2>Confira os veículos e suas fotos</h2>
              <p>Nenhuma alteração foi gravada. A importação só começa após sua confirmação.</p>
              <div className="package-import-totals">
                <div>
                  <strong>{packagePreview.summary.created}</strong>
                  <span>Novos</span>
                </div>
                <div>
                  <strong>{packagePreview.summary.updated}</strong>
                  <span>Atualizados</span>
                </div>
                <div>
                  <strong>{packagePreview.summary.photos || 0}</strong>
                  <span>Fotos novas</span>
                </div>
                <div>
                  <strong>{packagePreview.summary.failed}</strong>
                  <span>Erros</span>
                </div>
              </div>
              <div
                className="package-import-list"
                role="region"
                aria-label="Veículos encontrados no pacote"
              >
                {(packagePreview.summary.photoRows || []).map((row) => (
                  <div className="package-import-row" key={row.row}>
                    <div>
                      <strong>{row.label}</strong>
                      <small>
                        Estoque {row.stockCode} · Linha {row.row}
                      </small>
                    </div>
                    <span>
                      {row.action} · {row.images} {row.images === 1 ? 'foto' : 'fotos'}
                    </span>
                  </div>
                ))}
              </div>
              {packagePreview.summary.errors.length > 0 && (
                <div className="package-import-errors" role="alert">
                  <strong>
                    {packagePreview.summary.failed} linha(s) com erro serão ignoradas.
                  </strong>
                  {packagePreview.summary.errors.slice(0, 10).map((item) => (
                    <p key={item.row}>
                      Linha {item.row}: {item.error}
                    </p>
                  ))}
                </div>
              )}
              <p className="package-import-disclaimer">
                Fotos novas serão associadas ao código de estoque. Fotos existentes não serão
                substituídas; registros duplicados ou com anúncios ativos permanecem protegidos. O
                pacote não publica anúncios.
              </p>
              <div className="package-import-actions">
                <button
                  className="secondary"
                  type="button"
                  disabled={importing}
                  onClick={() => setPackagePreview(null)}
                >
                  Cancelar
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={
                    importing ||
                    packagePreview.summary.created + packagePreview.summary.updated === 0
                  }
                  onClick={() => void confirmPackageImport()}
                >
                  <Upload size={17} />
                  {importing ? 'Importando fotos e veículos...' : 'Confirmar importação'}
                </button>
              </div>
            </aside>
          </div>,
          document.body,
        )}
      <div className="stats">
        <article>
          <span className="stat-icon blue">
            <Car />
          </span>
          <div>
            <small>Total no estoque</small>
            <strong>{summary?.total ?? pagination.totalItems}</strong>
            <em>veículos ativos</em>
          </div>
        </article>
        <article>
          <span className="stat-icon green">
            <Check />
          </span>
          <div>
            <small>Publicados</small>
            <strong>
              {summary?.published ?? vehicles.filter((v) => v.status === 'Publicado').length}
            </strong>
            <em>anúncios ativos</em>
          </div>
        </article>
        <article>
          <span className="stat-icon amber">
            <Clock3 />
          </span>
          <div>
            <small>Prontos para publicar</small>
            <strong>
              {summary?.readyStatus ?? vehicles.filter((v) => v.status === 'Pronto').length}
            </strong>
            <em>disponíveis para agendar</em>
          </div>
        </article>
        <article>
          <span className="stat-icon red">
            <CircleAlert />
          </span>
          <div>
            <small>Precisam de atenção</small>
            <strong>
              {summary?.attention ?? vehicles.filter((v) => v.status === 'Atenção').length}
            </strong>
            <em>revisar dados</em>
          </div>
        </article>
      </div>
      <div className="vehicle-filter-section">
        <div className="vehicle-filter-heading">
          <div>
            <h2>Estoque cadastrado</h2>
            <p>Filtre por etapa e selecione veículos para gerenciar.</p>
          </div>
          {summary && (
            <span className="vehicle-photo-warning">
              <ImagePlus size={16} />
              {summary.noPhotos ?? 0} sem fotos no estoque
            </span>
          )}
        </div>
        <div
          className="vehicle-status-filters"
          role="group"
          aria-label="Filtrar veículos por situação"
        >
          {[
            { label: 'Todos', value: 'Todos', count: summary?.total },
            { label: 'Prontos', value: 'Pronto', count: summary?.readyStatus },
            { label: 'Publicados', value: 'Publicado', count: summary?.published },
            { label: 'Atenção', value: 'Atenção', count: summary?.attention },
            { label: 'Rascunhos', value: 'Rascunho' },
          ].map((option) => (
            <button
              type="button"
              key={option.value}
              className={status === option.value ? 'active' : ''}
              aria-pressed={status === option.value}
              onClick={() => changeStatusFilter(option.value)}
            >
              {option.label}
              {option.count !== undefined && <span>{option.count}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="panel vehicle-inventory-panel">
        <div className="toolbar">
          <div className="search">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
                setPageLoading(true)
                setSelected(new Set())
              }}
              placeholder="Marca, modelo, código ou responsável..."
              aria-label="Buscar veículos no estoque"
            />
          </div>
          <select
            value={status}
            onChange={(event) => changeStatusFilter(event.target.value)}
            aria-label="Filtrar veículos por status"
          >
            <option>Todos</option>
            {VEHICLE_STATUSES.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <span
            className="vehicle-scope-note"
            title="A consulta inclui os veículos da organização atual"
          >
            <Car size={15} />
            Organização atual
          </span>
        </div>
        {selected.size > 0 && (
          <div className="bulk-bar">
            <div>
              <Check />
              <strong>{selected.size}</strong>
              <span>selecionado{selected.size > 1 ? 's' : ''}</span>
            </div>
            <HelpTip
              tone="warning"
              text="A exclusão remove os veículos, suas fotos e os registros de publicação relacionados. Uma confirmação será solicitada."
              placement="bottom"
            />
            <button onClick={() => remove([...selected])}>
              <Trash2 />
              Excluir selecionados
            </button>
            <button className="bulk-clear" onClick={() => setSelected(new Set())}>
              <X />
              Limpar
            </button>
          </div>
        )}
        <div className="table-wrap" role="region" aria-label="Tabela de veículos" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th className="check-cell">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Selecionar todos os veículos desta página"
                  />
                </th>
                <th>VEÍCULO</th>
                <th>PREÇO</th>
                <th>QUILOMETRAGEM</th>
                <th>RESPONSÁVEL</th>
                <th>STATUS</th>
                <th>FOTOS</th>
                <th>ATUALIZADO</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((vehicle) => (
                <tr key={vehicle.id} className={selected.has(vehicle.id) ? 'selected-row' : ''}>
                  <td className="check-cell">
                    <input
                      type="checkbox"
                      checked={selected.has(vehicle.id)}
                      onChange={() => toggleOne(vehicle.id)}
                      aria-label={`Selecionar ${vehicle.year} ${vehicle.make} ${vehicle.model}`}
                    />
                  </td>
                  <td>
                    <div className="vehicle">
                      <Thumb vehicle={vehicle} />
                      <div>
                        <strong>
                          {vehicle.year} {vehicle.make} {vehicle.model}
                        </strong>
                        <small>
                          {vehicle.trim}
                          {vehicle.stockCode ? ` · Estoque ${vehicle.stockCode}` : ''}
                        </small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <strong>{money.format(vehicle.price)}</strong>
                  </td>
                  <td>{vehicle.km.toLocaleString('pt-BR')} km</td>
                  <td>
                    <div className="seller">
                      <span>{vehicle.initials}</span>
                      {vehicle.seller}
                    </div>
                  </td>
                  <td>
                    <Badge status={vehicle.status} />
                  </td>
                  <td>
                    <span className={`image-status ${vehicle.imageCount ? 'has-images' : ''}`}>
                      {vehicle.imageCount || 0}/20
                    </span>
                  </td>
                  <td className="muted">
                    {vehicle.updatedAt
                      ? new Date(vehicle.updatedAt + 'Z').toLocaleDateString('pt-BR')
                      : 'agora'}
                  </td>
                  <td className="actions-cell">
                    <button
                      className="row-more"
                      onClick={(event) => toggleMenu(event, vehicle.id)}
                      aria-label={`Ações de ${vehicle.year} ${vehicle.make} ${vehicle.model}`}
                      aria-expanded={menu?.vehicleId === vehicle.id}
                    >
                      <MoreHorizontal />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && (
            <div className="empty" role="status">
              {pageLoading
                ? 'Carregando veículos...'
                : query || status !== 'Todos'
                  ? 'Nenhum veículo corresponde aos filtros selecionados.'
                  : 'Seu estoque está vazio. Cadastre o primeiro veículo para começar.'}
            </div>
          )}
        </div>
        <footer className="panel-foot">
          <span role="status">
            {pageLoading
              ? 'Atualizando resultados...'
              : `Exibindo ${filtered.length} de ${pagination.totalItems} veículos`}
          </span>
          <div>
            <button
              disabled={pageLoading || pagination.currentPage <= 1}
              onClick={() => {
                setPage((current) => Math.max(1, current - 1))
                setPageLoading(true)
                setSelected(new Set())
              }}
            >
              Anterior
            </button>
            <button className="page">
              {pagination.currentPage} / {pagination.totalPages}
            </button>
            <button
              disabled={pageLoading || pagination.currentPage >= pagination.totalPages}
              onClick={() => {
                setPage((current) => Math.min(pagination.totalPages, current + 1))
                setPageLoading(true)
                setSelected(new Set())
              }}
            >
              Próximo
            </button>
          </div>
        </footer>
      </div>

      {menu &&
        menuVehicle &&
        createPortal(
          <>
            <button
              className="row-menu-backdrop"
              onClick={() => setMenu(null)}
              aria-label="Fechar ações"
            />
            <div
              className="row-menu floating-row-menu"
              style={{ top: menu.top, left: menu.left }}
              role="menu"
            >
              <div className="row-menu-action">
                <button
                  onClick={() => {
                    setEditor(menuVehicle)
                    setMenu(null)
                  }}
                >
                  <Edit3 />
                  Editar e gerenciar fotos
                </button>
              </div>
              {menuVehicle.status !== 'Vendido' && (
                <div className="row-menu-action">
                  <button
                    onClick={() => {
                      setQueueVehicle(menuVehicle)
                      setMenu(null)
                    }}
                  >
                    <Send />
                    Adicionar à fila
                  </button>
                  <HelpTip
                    text="Escolha o perfil do Brave. A extensão seguirá as etapas de avanço, grupos e publicação definidas em Configurações."
                    placement="bottom"
                  />
                </div>
              )}
              {menuVehicle.status !== 'Vendido' && (
                <div className="row-menu-action">
                  <button onClick={() => markSold(menuVehicle.id)}>
                    <Tag />
                    Marcar como vendido
                  </button>
                  <HelpTip
                    tone="warning"
                    text="Remova o anúncio do Facebook em até 24h após a venda. O AutoFlow vai lembrar você."
                    placement="bottom"
                  />
                </div>
              )}
              <div className="row-menu-action danger">
                <button onClick={() => remove([menuVehicle.id])}>
                  <Trash2 />
                  Excluir veículo
                </button>
                <HelpTip
                  tone="warning"
                  text="Também remove fotos e históricos de publicação deste veículo."
                  placement="bottom"
                />
              </div>
            </div>
          </>,
          document.body,
        )}
      {editor !== undefined && (
        <VehicleDrawer
          api={api}
          vehicle={editor}
          onClose={() => setEditor(undefined)}
          onSaved={async (message) => {
            setEditor(undefined)
            notify(message)
            await reload()
          }}
        />
      )}
      {queueVehicle && (
        <QueueDrawer
          api={api}
          vehicle={queueVehicle}
          accounts={accounts}
          onClose={() => setQueueVehicle(null)}
          onQueued={async () => {
            setQueueVehicle(null)
            notify('Veículo adicionado à fila do perfil selecionado. Abra ou atualize a extensão.')
            await reload()
          }}
        />
      )}
    </section>
  )
}

function QueueDrawer({
  api,
  vehicle,
  accounts,
  onClose,
  onQueued,
}: {
  api: ApiFn
  vehicle: VehicleRecord
  accounts: AccountOption[]
  onClose: () => void
  onQueued: () => Promise<void>
}) {
  const [accountId, setAccountId] = useState(
    accounts.find((account) => !account.automationPaused)?.id || 0,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await api('/publications', {
        method: 'POST',
        body: JSON.stringify({ vehicleId: vehicle.id, accountId }),
      })
      await onQueued()
    } catch (caught) {
      const missing = (caught as { missing?: string[] })?.missing
      setError(
        missing?.length
          ? `Complete antes de publicar: ${missing.join(', ')}.`
          : caught instanceof Error
            ? caught.message
            : 'Erro ao adicionar à fila',
      )
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <aside className="drawer queue-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <DrawerFocusGuard label="Escolher perfil do Brave" onClose={onClose} />
        <button className="close" onClick={onClose} aria-label="Fechar fila">
          <X />
        </button>
        <span className="eyebrow">FILA DA EXTENSÃO</span>
        <h2>Escolher perfil do Brave</h2>
        <p>
          {vehicle.year} {vehicle.make} {vehicle.model} será exibido somente na fila do perfil
          selecionado.
        </p>
        {error && (
          <div className="auth-error">
            <CircleAlert />
            {error}
          </div>
        )}
        {accounts.length ? (
          <form onSubmit={submit}>
            <label>
              Perfil que fará o preenchimento
              <select
                value={accountId}
                onChange={(event) => setAccountId(Number(event.target.value))}
                required
              >
                {accounts.map((account) => (
                  <option
                    key={account.id}
                    value={account.id}
                    disabled={Boolean(account.automationPaused)}
                  >
                    {account.label}
                    {account.browserProfile ? ` · ${account.browserProfile}` : ''}
                    {account.automationPaused ? ' · pausado' : ''}
                  </option>
                ))}
              </select>
            </label>
            {!accounts.some((account) => !account.automationPaused) && (
              <div className="auth-error">
                <CircleAlert />
                Todos os perfis estão com a automação pausada. Revise o motivo em Equipe e contas.
              </div>
            )}
            <div className="queue-explanation">
              <Send />
              <div>
                <strong>Depois de adicionar</strong>
                <span>Abra a extensão nesse perfil do Brave e clique em “Abrir e preencher”.</span>
              </div>
            </div>
            <button className="primary" disabled={saving || !accountId}>
              {saving ? 'Adicionando...' : 'Adicionar à fila deste perfil'}
            </button>
          </form>
        ) : (
          <div className="account-empty">
            <Send />
            <h3>Nenhum perfil associado</h3>
            <p>Cadastre um perfil em Equipe e contas antes de criar a tarefa da extensão.</p>
          </div>
        )}
      </aside>
    </div>
  )
}

function VehicleDrawer({
  api,
  vehicle,
  onClose,
  onSaved,
}: {
  api: ApiFn
  vehicle: VehicleRecord | null
  onClose: () => void
  onSaved: (message: string) => Promise<void>
}) {
  const [images, setImages] = useState<ImageRecord[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [persistedVehicleId, setPersistedVehicleId] = useState<number | undefined>(vehicle?.id)
  const [description, setDescription] = useState(vehicle?.description || '')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiTone, setAiTone] = useState<'vendedor' | 'profissional' | 'amigável' | 'direto'>(
    'vendedor',
  )

  useEffect(() => {
    if (vehicle)
      api<{ images: ImageRecord[] }>(`/vehicles/${vehicle.id}/images`)
        .then((data) => setImages(data.images))
        .catch(() => setImages([]))
  }, [api, vehicle])

  async function upload(vehicleId: number) {
    for (const file of files.slice(0, 20 - images.length)) {
      const image = await api<{ id: number; url: string }>(`/vehicles/${vehicleId}/images`, {
        method: 'POST',
        body: JSON.stringify(await filePayload(file)),
      })
      setImages((current) => [
        ...current,
        { id: image.id, originalName: file.name, url: image.url, mimeType: file.type },
      ])
      setFiles((current) => current.filter((item) => item !== file))
    }
  }

  async function generateAiDescription(formElement: HTMLFormElement) {
    setAiLoading(true)
    setError('')
    const form = new FormData(formElement)
    const vehicleData = {
      year: Number(form.get('year')),
      make: form.get('make'),
      model: form.get('model'),
      trim: form.get('trim'),
      price: Number(form.get('price')),
      km: Number(form.get('km')),
      stockCode: form.get('stockCode'),
      vin: form.get('vin'),
      vehicleType: form.get('vehicleType'),
      location: form.get('location'),
      transmission: form.get('transmission'),
      fuelType: form.get('fuelType'),
      bodyType: form.get('bodyType'),
      exteriorColor: form.get('exteriorColor'),
      interiorColor: form.get('interiorColor'),
      condition: form.get('condition'),
    }
    if (!vehicleData.make || !vehicleData.model) {
      setError('Selecione a fabricante e informe o modelo antes de gerar a descrição com IA.')
      setAiLoading(false)
      return
    }
    try {
      const res = await api<{
        ok: boolean
        description: string
        provider: string
        hashtags?: string[]
      }>('/ai/generate-description', {
        method: 'POST',
        body: JSON.stringify({ vehicle: vehicleData, tone: aiTone }),
      })
      if (res.description) {
        const textWithTags = res.hashtags?.length
          ? `${res.description}\n\n${res.hashtags.join(' ')}`
          : res.description
        setDescription(textWithTags)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao gerar descrição com IA')
    } finally {
      setAiLoading(false)
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    const form = new FormData(event.currentTarget)
    const payload = {
      year: Number(form.get('year')),
      make: form.get('make'),
      model: form.get('model'),
      trim: form.get('trim'),
      price: Number(form.get('price')),
      km: Number(form.get('km')),
      vehicleType: form.get('vehicleType'),
      location: form.get('location'),
      transmission: form.get('transmission'),
      fuelType: form.get('fuelType'),
      bodyType: form.get('bodyType'),
      exteriorColor: form.get('exteriorColor'),
      interiorColor: form.get('interiorColor'),
      condition: form.get('condition'),
      description: form.get('description'),
      status: form.get('status'),
    }
    try {
      let id = persistedVehicleId
      if (id) await api(`/vehicles/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      else {
        id = (
          await api<{ id: number }>('/vehicles', { method: 'POST', body: JSON.stringify(payload) })
        ).id
        setPersistedVehicleId(id)
      }
      await upload(id!)
      await onSaved(
        vehicle || persistedVehicleId
          ? 'Veículo atualizado com sucesso.'
          : 'Veículo adicionado ao estoque.',
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Erro ao salvar veículo. O cadastro foi preservado para retomada.',
      )
      setSaving(false)
    }
  }

  async function removeImage(image: ImageRecord) {
    await api(`/vehicle-images/${image.id}`, { method: 'DELETE' })
    setImages((current) => current.filter((item) => item.id !== image.id))
  }

  async function moveImage(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= images.length || !vehicle) return
    const sourceImage = images[index],
      targetImage = images[target]
    if (!sourceImage || !targetImage) return
    const next = [...images]
    ;[next[index], next[target]] = [targetImage, sourceImage]
    const previous = images
    setImages(next)
    try {
      await api(`/vehicles/${vehicle.id}/images/reorder`, {
        method: 'PATCH',
        body: JSON.stringify({ order: next.map((item) => item.id) }),
      })
    } catch (caught) {
      setImages(previous)
      setError(caught instanceof Error ? caught.message : 'Erro ao reordenar fotos')
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <aside className="drawer vehicle-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <DrawerFocusGuard
          label={vehicle ? 'Editar veículo' : 'Adicionar veículo'}
          onClose={onClose}
        />
        <button className="close" onClick={onClose} aria-label="Fechar veículo">
          <X />
        </button>
        <span className="eyebrow">{vehicle ? 'EDITAR ESTOQUE' : 'NOVO REGISTRO'}</span>
        <h2>{vehicle ? 'Editar veículo' : 'Adicionar veículo'}</h2>
        <p>Escolha os mesmos valores usados pelo Marketplace e adicione até 20 fotos.</p>
        {error && (
          <div className="auth-error">
            <CircleAlert />
            {error}
          </div>
        )}
        <form onSubmit={submit}>
          <div className="drawer-section">
            <h3>Identificação</h3>
            <div className="vehicle-form-grid">
              <label>
                <FieldLabel help="Define a categoria inicial do formulário do Marketplace.">
                  Tipo de veículo
                </FieldLabel>
                <select
                  name="vehicleType"
                  defaultValue={vehicle?.vehicleType || 'Carro/picape'}
                  required
                >
                  {withLegacyOption(VEHICLE_TYPES, vehicle?.vehicleType).map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel help="Ano/modelo anunciado. A lista acompanha os anos aceitos pelo Marketplace.">
                  Ano
                </FieldLabel>
                <select
                  name="year"
                  defaultValue={vehicle?.year || new Date().getFullYear()}
                  required
                >
                  {VEHICLE_YEARS.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel help="Selecione a montadora exatamente como aparece no Marketplace.">
                  Fabricante
                </FieldLabel>
                <select name="make" defaultValue={vehicle?.make || ''} required>
                  <option value="" disabled>
                    Selecione a fabricante
                  </option>
                  {withLegacyOption(VEHICLE_MAKES, vehicle?.make).map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel help="Informe o modelo sem repetir fabricante ou ano. A extensão tentará escolher a sugestão correspondente.">
                  Modelo
                </FieldLabel>
                <input
                  name="model"
                  defaultValue={vehicle?.model || ''}
                  placeholder="Corolla"
                  required
                />
              </label>
              <label>
                <FieldLabel help="Versão ou acabamento, por exemplo XEi 2.0.">Versão</FieldLabel>
                <input name="trim" defaultValue={vehicle?.trim || ''} placeholder="XEi 2.0" />
              </label>
              <label>
                <FieldLabel help="Código interno único do estoque. É usado para evitar importações e cadastros duplicados.">
                  ID de estoque
                </FieldLabel>
                <input
                  name="stockCode"
                  defaultValue={vehicle?.stockCode || ''}
                  placeholder="Ex.: LJ-004218"
                  maxLength={64}
                />
              </label>
              <label>
                <FieldLabel help="VIN ou chassi. Quando informado, também é tratado como identificador único dentro da empresa.">
                  VIN / chassi
                </FieldLabel>
                <input
                  name="vin"
                  defaultValue={vehicle?.vin || ''}
                  placeholder="Ex.: 9BW..."
                  maxLength={32}
                  autoCapitalize="characters"
                />
              </label>
              <label>
                <FieldLabel help="Cidade usada no anúncio. Se ficar em branco, será aplicada a localização padrão das Configurações. O Facebook pode pedir a confirmação de uma sugestão.">
                  Localização
                </FieldLabel>
                <input
                  name="location"
                  defaultValue={vehicle?.location || ''}
                  placeholder="Usar localização padrão das Configurações"
                />
              </label>
            </div>
          </div>
          <div className="drawer-section">
            <h3>Detalhes</h3>
            <div className="vehicle-form-grid">
              <label>
                <FieldLabel help="Valor total anunciado, sem pontos ou símbolo de moeda.">
                  Preço
                </FieldLabel>
                <input
                  name="price"
                  type="number"
                  min="1"
                  defaultValue={vehicle?.price || 0}
                  required
                />
              </label>
              <label>
                <FieldLabel help="Quilometragem atual em números inteiros. Veículo zero km pode usar 0.">
                  Quilometragem
                </FieldLabel>
                <input name="km" type="number" min="0" defaultValue={vehicle?.km || 0} required />
              </label>
              <label>
                <FieldLabel help="Opções limitadas aos valores aceitos pelo Marketplace.">
                  Câmbio
                </FieldLabel>
                <select
                  name="transmission"
                  defaultValue={vehicle?.transmission || 'Automático'}
                  required
                >
                  {withLegacyOption(TRANSMISSIONS, vehicle?.transmission).map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel help="Informe o combustível principal aceito pelo veículo.">
                  Combustível
                </FieldLabel>
                <select name="fuelType" defaultValue={vehicle?.fuelType || 'Flex'} required>
                  {withLegacyOption(FUEL_TYPES, vehicle?.fuelType).map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel help="Formato da carroceria conforme a lista do Facebook.">
                  Carroceria
                </FieldLabel>
                <select name="bodyType" defaultValue={vehicle?.bodyType || 'Sedã'} required>
                  {withLegacyOption(BODY_TYPES, vehicle?.bodyType).map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel help="Estado geral do veículo conforme as opções fixas exibidas pelo Marketplace.">
                  Condição do veículo
                </FieldLabel>
                <select name="condition" defaultValue={vehicle?.condition || ''} required>
                  <option value="" disabled>
                    Selecione a condição
                  </option>
                  {withLegacyOption(VEHICLE_CONDITIONS, vehicle?.condition).map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel help="Selecione a cor externa exatamente como aparece no Marketplace.">
                  Cor externa
                </FieldLabel>
                <select name="exteriorColor" defaultValue={vehicle?.exteriorColor || ''} required>
                  <option value="" disabled>
                    Selecione a cor externa
                  </option>
                  {withLegacyOption(VEHICLE_COLORS, vehicle?.exteriorColor).map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel help="Selecione a cor predominante do interior. Este campo também é uma lista fixa no Marketplace.">
                  Cor interna
                </FieldLabel>
                <select name="interiorColor" defaultValue={vehicle?.interiorColor || ''} required>
                  <option value="" disabled>
                    Selecione a cor interna
                  </option>
                  {withLegacyOption(VEHICLE_COLORS, vehicle?.interiorColor).map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <FieldLabel help="O status muda automaticamente ao entrar na fila e ao confirmar a publicação.">
                  Status
                </FieldLabel>
                <select name="status" defaultValue={vehicle?.status || 'Rascunho'}>
                  {VEHICLE_STATUSES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="description-header-actions">
              <FieldLabel help="Inclua conservação, opcionais e condições reais. Evite promessas não verificáveis.">
                Descrição
              </FieldLabel>
              <div className="ai-gen-controls">
                <select
                  value={aiTone}
                  onChange={(e) => setAiTone(e.target.value as typeof aiTone)}
                  className="ai-tone-select"
                  aria-label="Tom da descrição com IA"
                  disabled={aiLoading}
                >
                  <option value="vendedor">Tom Vendedor</option>
                  <option value="profissional">Tom Profissional</option>
                  <option value="amigável">Tom Amigável</option>
                  <option value="direto">Tom Direto</option>
                </select>
                <button
                  type="button"
                  className="ai-gen-button"
                  disabled={aiLoading}
                  onClick={(e) => {
                    const form = e.currentTarget.closest('form')
                    if (form) void generateAiDescription(form)
                  }}
                >
                  <Sparkles size={13} />
                  {aiLoading ? 'Gerando...' : 'Gerar com IA'}
                </button>
              </div>
            </div>
            <textarea
              name="description"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Se ficar em branco, será usado o modelo definido nas Configurações."
            />
          </div>
          <div className="drawer-section">
            <h3 className="section-title-help">
              Fotos <span>{images.length + files.length}/20</span>
              <HelpTip text="A primeira foto vira a capa. Use as setas para reordenar; a extensão envia no máximo 20 na ordem cadastrada." />
            </h3>
            {images.length > 0 && (
              <div className="image-grid">
                {images.map((image, index) => (
                  <div key={image.id}>
                    {index === 0 && <span className="cover-badge">Capa</span>}
                    <img src={image.url} alt={image.originalName} />
                    <button
                      type="button"
                      onClick={() => removeImage(image)}
                      aria-label={`Excluir ${image.originalName}`}
                    >
                      <X />
                    </button>
                    <div className="move-controls">
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => moveImage(index, -1)}
                        aria-label={`Mover ${image.originalName} para a esquerda`}
                      >
                        <ChevronLeft />
                      </button>
                      <button
                        type="button"
                        disabled={index === images.length - 1}
                        onClick={() => moveImage(index, 1)}
                        aria-label={`Mover ${image.originalName} para a direita`}
                      >
                        <ChevronRight />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {images.length < 20 && (
              <label className="image-upload">
                <ImagePlus />
                <strong>Adicionar fotos</strong>
                <span>JPG, PNG ou WebP · até 12 MB cada</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={(event) =>
                    setFiles((current) =>
                      [...current, ...[...(event.target.files || [])]].slice(0, 20 - images.length),
                    )
                  }
                />
              </label>
            )}
            {files.length > 0 && (
              <div className="pending-files">
                {files.map((file) => (
                  <span key={file.name}>{file.name}</span>
                ))}
              </div>
            )}
          </div>
          <button className="primary save-vehicle" disabled={saving}>
            {saving ? 'Salvando...' : vehicle ? 'Salvar alterações' : 'Adicionar ao estoque'}
          </button>
        </form>
      </aside>
    </div>
  )
}
