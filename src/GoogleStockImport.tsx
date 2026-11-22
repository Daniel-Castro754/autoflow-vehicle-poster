import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CloudDownload, ExternalLink, ShieldCheck, X } from 'lucide-react'
import { DrawerFocusGuard } from './DrawerFocusGuard'

type ApiFn = <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>
export type GoogleStockIssue = { row: number; stockCode: string; message: string }
export type GoogleStockPrepared = {
  zipBase64: string
  selected: number
  valid: number
  photos: number
  ignored: number
  issues: GoogleStockIssue[]
  vehicles: Array<{ row: number; stockCode: string; label: string; photos: number }>
  fingerprint: string
}
type Status = {
  oauthConfigured: boolean
  connected: boolean
  spreadsheetId: string
  rootFolderId: string
  connectedAt: string | null
}

export function GoogleStockImport({
  api,
  onClose,
  onImport,
}: {
  api: ApiFn
  onClose: () => void
  onImport: (data: GoogleStockPrepared, mode: 'update' | 'skip') => Promise<void>
}) {
  const [status, setStatus] = useState<Status | null>(null)
  const [spreadsheetId, setSpreadsheetId] = useState('')
  const [rootFolderId, setRootFolderId] = useState('')
  const [mode, setMode] = useState<'update' | 'skip'>('skip')
  const [prepared, setPrepared] = useState<GoogleStockPrepared | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api<Status>('/google-stock/status')
      .then((data) => {
        if (!active) return
        setStatus(data)
        setSpreadsheetId(data.spreadsheetId || '')
        setRootFolderId(data.rootFolderId || '')
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Falha de conexão.')
      })
    return () => { active = false }
  }, [api])

  async function save() {
    setBusy(true)
    setError('')
    try {
      const data = await api<{ spreadsheetId: string; rootFolderId: string }>('/google-stock/config', {
        method: 'POST',
        body: JSON.stringify({ spreadsheetId, rootFolderId }),
      })
      setSpreadsheetId(data.spreadsheetId)
      setRootFolderId(data.rootFolderId)
      setStatus((old) => old && ({ ...old, spreadsheetId: data.spreadsheetId, rootFolderId: data.rootFolderId }))
      setPrepared(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível salvar as referências.')
    } finally {
      setBusy(false)
    }
  }
  async function connect() {
    setBusy(true)
    setError('')
    try {
      const result = await api<{ authUrl: string }>('/google-stock/connect', { method: 'POST' })
      const target = new URL(result.authUrl)
      if (target.origin !== 'https://accounts.google.com')
        throw new Error('O Google retornou uma URL de autorização inesperada.')
      window.location.assign(target.href)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível abrir a autorização.')
      setBusy(false)
    }
  }
  async function disconnect() {
    if (!window.confirm('Desconectar o acesso de leitura ao Google? Os veículos atuais serão preservados.')) return
    setBusy(true)
    setError('')
    try {
      await api('/google-stock/disconnect', { method: 'POST' })
      setStatus((old) => old && ({ ...old, connected: false, connectedAt: null }))
      setPrepared(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Falha ao desconectar.')
    } finally {
      setBusy(false)
    }
  }
  async function prepare() {
    setBusy(true)
    setError('')
    setPrepared(null)
    try {
      const data = await api<GoogleStockPrepared>('/google-stock/prepare', { method: 'POST' })
      setPrepared(data)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível ler o Google Drive.')
    } finally {
      setBusy(false)
    }
  }
  async function reviewImport() {
    if (!prepared?.zipBase64 || busy) return
    setBusy(true)
    setError('')
    try {
      await onImport(prepared, mode)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Falha ao validar os veículos.')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="overlay google-stock-overlay" onMouseDown={() => !busy && onClose()}>
      <aside className="drawer google-stock-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <DrawerFocusGuard label="Sincronização supervisionada do Google Sheets e Drive" onClose={() => !busy && onClose()} />
        <button type="button" className="close" onClick={onClose} disabled={busy} aria-label="Fechar integração Google">
          <X size={20} />
        </button>
        <span className="page-kicker">ESTOQUE · GOOGLE SHEETS + DRIVE</span>
        <h2>Sincronizar com Google</h2>
        <p>A planilha é a fonte dos dados. Cada pasta individual contém <strong>anuncio.txt</strong>,
          fotos e <strong>PRONTO.flag</strong>. Nada será importado sem revisão e confirmação.</p>
        <div className="google-stock-state">
          <ShieldCheck size={17} />
          {status?.connected ? 'Conta Google autorizada para leitura' : 'Conta Google não conectada'}
          <small>Esta conexão nunca publica anúncios nem cria trabalhos na fila.</small>
        </div>
        {error && <div className="auth-error" role="alert">{error}</div>}
        {!status && !error && <p role="status">Carregando configuração...</p>}
        {status && (
          <>
            {!status.oauthConfigured && (
              <div className="auth-error" role="alert">
                Configure GOOGLE_STOCK_CLIENT_ID e GOOGLE_STOCK_CLIENT_SECRET no .env do Docker antes de conectar.
              </div>
            )}
            <div className="google-stock-fields">
              <label>
                ID ou link do cadastro central (aba Veiculos)
                <input
                  value={spreadsheetId}
                  disabled={busy}
                  onChange={(event) => setSpreadsheetId(event.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                />
              </label>
              <label>
                ID ou link da pasta Veiculos
                <input
                  value={rootFolderId}
                  disabled={busy}
                  onChange={(event) => setRootFolderId(event.target.value)}
                  placeholder="https://drive.google.com/drive/folders/..."
                />
              </label>
              <button className="secondary" type="button" onClick={() => void save()} disabled={busy || !spreadsheetId || !rootFolderId}>
                Salvar referências
              </button>
            </div>
            <div className="google-stock-actions">
              {status.connected ? (
                <button type="button" className="secondary" onClick={() => void disconnect()} disabled={busy}>
                  Desconectar Google
                </button>
              ) : (
                <button type="button" className="secondary" onClick={() => void connect()} disabled={busy || !status.oauthConfigured}>
                  Conectar conta Google
                </button>
              )}
              <label>
                Tratamento de existentes
                <select
                  value={mode}
                  onChange={(event) => { setMode(event.target.value as 'update' | 'skip'); setPrepared(null) }}
                  disabled={busy}
                >
                  <option value="skip">Somente novos (mais seguro)</option>
                  <option value="update">Atualizar existentes sem trabalhos ativos</option>
                </select>
              </label>
              <button
                type="button"
                className="primary"
                disabled={busy || !status.connected || !status.spreadsheetId || !status.rootFolderId || spreadsheetId !== status.spreadsheetId || rootFolderId !== status.rootFolderId}
                onClick={() => void prepare()}
              >
                <CloudDownload size={17} />
                {busy ? 'Consultando Google...' : 'Buscar prévia do Drive'}
              </button>
            </div>
          </>
        )}
        {prepared && (
          <section className="google-stock-results" aria-label="Resultado da consulta ao Google Drive">
            <strong>{prepared.valid} válidos · {prepared.photos} fotos · {prepared.issues.length} pendência(s)</strong>
            <p>{prepared.selected} marcados SIM; {prepared.ignored} ignorados pela planilha.</p>
            {prepared.vehicles.length > 0 && (
              <div className="google-stock-result-list">
                {prepared.vehicles.map((vehicle) => (
                  <div key={vehicle.row}>
                    <span>{vehicle.stockCode} — {vehicle.label}</span>
                    <small>{vehicle.photos} fotos</small>
                  </div>
                ))}
              </div>
            )}
            {prepared.issues.length > 0 && (
              <div className="google-stock-issues" role="alert">
                <strong>Veículos não preparados (não serão importados)</strong>
                {prepared.issues.map((issue) => (
                  <p key={issue.row}>Linha {issue.row} · {issue.stockCode || 'Sem código'}: {issue.message}</p>
                ))}
              </div>
            )}
            {prepared.valid > 0 && (
              <button className="primary" type="button" disabled={busy} onClick={() => void reviewImport()}>
                Revisar {prepared.valid} veículo(s) no importador
              </button>
            )}
          </section>
        )}
        <p className="google-stock-footnote">
          Conexão somente leitura. Fotos e anuncio.txt são baixados pelo servidor local;
          a prévia utiliza o mesmo validador de ZIP do Auto Flow.
          <a href="https://support.google.com/drive/answer/2375091" target="_blank" rel="noreferrer">
            Ajuda do Google Drive <ExternalLink size={12} />
          </a>
        </p>
      </aside>
    </div>,
    document.body,
  )
}
