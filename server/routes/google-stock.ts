import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import {
  createGoogleStockOAuth,
  createGoogleStockSource,
  GoogleStockError,
  normalizeGoogleFileId,
} from '../services/google-stock-provider.ts'
import { prepareGoogleStockPackage } from '../services/google-stock-package.ts'

type Auth = { userId: number; organizationId: number }
type Dependencies = {
  db: DatabaseSync
  send: (res: ServerResponse, status: number, data: unknown) => void
  jsonBody: (req: IncomingMessage, limit?: number) => Promise<unknown>
  isAdmin: (auth: Auth) => boolean
  publicOrigin: string
}

export function createGoogleStockRoutes({ db, send, jsonBody, isAdmin, publicOrigin }: Dependencies) {
  const oauth = createGoogleStockOAuth({
    redirectUri: publicOrigin + '/api/google-stock/oauth/callback',
  })
  const callbackPath = '/api/google-stock/oauth/callback'
  const base = '/api/google-stock'

  async function callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method !== 'GET' || url.pathname !== callbackPath) return false
    if (url.searchParams.get('error')) {
      send(res, 400, { error: 'A autorização Google foi cancelada. Nenhum dado foi importado.' })
      return true
    }
    try {
      await oauth.complete(
        db,
        url.searchParams.get('state'),
        url.searchParams.get('code'),
      )
      // Redirect is fixed by the server, never user-controlled. Do not put
      // OAuth code, state, refresh/access tokens or personal data in the URL.
      res.writeHead(303, {
        Location: publicOrigin + '/?google_stock=connected',
        'Cache-Control': 'no-store',
      })
      res.end()
    } catch (error) {
      if (error instanceof GoogleStockError) send(res, error.status, { error: error.message })
      else send(res, 502, { error: 'Não foi possível concluir a conexão com Google.' })
    }
    return true
  }

  async function authorized(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    auth: Auth,
  ) {
    if (!url.pathname.startsWith(base + '/') && url.pathname !== base) return false
    if (!isAdmin(auth)) {
      send(res, 403, { error: 'Apenas administradores podem configurar e sincronizar o Google Drive.' })
      return true
    }
    const row = db
      .prepare('SELECT spreadsheet_id spreadsheetId,root_folder_id rootFolderId,' +
          'refresh_token_enc token,connected_at connectedAt FROM google_stock_connections ' +
          'WHERE organization_id=?')
      .get(auth.organizationId) as
        | { spreadsheetId: string; rootFolderId: string; token: string; connectedAt: string | null }
        | undefined

    if (req.method === 'GET' && url.pathname === base + '/status') {
      send(res, 200, {
        oauthConfigured: oauth.configured,
        connected: Boolean(row?.token),
        spreadsheetId: row?.spreadsheetId || '',
        rootFolderId: row?.rootFolderId || '',
        connectedAt: row?.connectedAt || null,
        automaticImport: false,
        automaticPublication: false,
      })
      return true
    }
    if (req.method === 'POST' && url.pathname === base + '/config') {
      const raw = await jsonBody(req, 4096)
      const body = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
      try {
        const spreadsheetId = normalizeGoogleFileId(body.spreadsheetId)
        const rootFolderId = normalizeGoogleFileId(body.rootFolderId)
        if (spreadsheetId === rootFolderId)
          throw new GoogleStockError(400, 'Informe uma planilha e uma pasta distintas.')
        db.prepare(
          "INSERT INTO google_stock_connections (organization_id,spreadsheet_id,root_folder_id) " +
            "VALUES(?,?,?) ON CONFLICT(organization_id) DO UPDATE SET " +
            "spreadsheet_id=excluded.spreadsheet_id,root_folder_id=excluded.root_folder_id," +
            "updated_at=CURRENT_TIMESTAMP",
        ).run(auth.organizationId, spreadsheetId, rootFolderId)
        send(res, 200, { ok: true, spreadsheetId, rootFolderId })
      } catch (error) {
        send(res, error instanceof GoogleStockError ? error.status : 400, {
          error: error instanceof GoogleStockError ? error.message : 'Configuração inválida.',
        })
      }
      return true
    }
    if (req.method === 'POST' && url.pathname === base + '/connect') {
      try {
        const authUrl = oauth.start(auth.organizationId, auth.userId)
        send(res, 200, { authUrl })
      } catch (error) {
        send(res, error instanceof GoogleStockError ? error.status : 500, {
          error: error instanceof GoogleStockError ? error.message : 'Não foi possível iniciar a conexão.',
        })
      }
      return true
    }
    if (req.method === 'POST' && url.pathname === base + '/disconnect') {
      db.prepare(
        "UPDATE google_stock_connections SET refresh_token_enc='',connected_at=NULL," +
          "connected_by=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=?",
      ).run(auth.organizationId)
      send(res, 200, { ok: true })
      return true
    }
    if (req.method === 'POST' && url.pathname === base + '/prepare') {
      if (!row?.spreadsheetId || !row.rootFolderId) {
        send(res, 409, { error: 'Configure a planilha central e a pasta Veiculos.' })
        return true
      }
      try {
        const client = oauth.authorizedClient(db, auth.organizationId)
        const source = createGoogleStockSource(client)
        const data = await prepareGoogleStockPackage(
          source,
          row.spreadsheetId,
          row.rootFolderId,
        )
        res.setHeader('Cache-Control', 'no-store')
        send(res, 200, data)
      } catch (error) {
        send(res, error instanceof GoogleStockError ? error.status : 502, {
          error: error instanceof GoogleStockError
            ? error.message
            : 'Não foi possível preparar a importação. Nenhum veículo foi alterado.',
        })
      }
      return true
    }
    send(res, 404, { error: 'Rota de estoque Google não encontrada.' })
    return true
  }
  return { callback, authorized }
}
