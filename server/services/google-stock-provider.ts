import { randomBytes } from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'
import type { DatabaseSync } from 'node:sqlite'
import { decryptCredential, encryptCredential } from './credential-vault.ts'

export class GoogleStockError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export type GoogleFile = {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  md5Checksum?: string
  parents?: string[]
}

export type GoogleStockSource = {
  spreadsheetRows(spreadsheetId: string): Promise<unknown[][]>
  folderInfo(folderId: string): Promise<GoogleFile>
  listFiles(folderId: string): Promise<GoogleFile[]>
  download(fileId: string, sizeLimit: number): Promise<Buffer>
}

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
]
const STATE_LIFETIME_MS = 10 * 60_000
const MAX_OAUTH_STATES = 100
type Pending = { org: number; user: number; expiresAt: number }

export function normalizeGoogleFileId(input: unknown): string {
  const value = String(input || '').trim()
  const path = /(?:\/folders\/|\/spreadsheets\/d\/|[?&]id=)([A-Za-z0-9_-]{12,160})(?:\/|[?&#]|$)/.exec(value)
  const id = path ? path[1]! : value
  if (!/^[A-Za-z0-9_-]{12,160}$/.test(id))
    throw new GoogleStockError(400, 'Informe um ID ou link válido do Google Drive/Sheets.')
  return id
}

export function createGoogleStockOAuth({
  clientId = process.env.GOOGLE_STOCK_CLIENT_ID?.trim() || '',
  clientSecret = process.env.GOOGLE_STOCK_CLIENT_SECRET?.trim() || '',
  redirectUri,
  createClient,
}: {
  redirectUri: string
  clientId?: string
  clientSecret?: string
  createClient?: () => OAuth2Client
}) {
  const pending = new Map<string, Pending>()
  const configured = Boolean(clientId && clientSecret)
  function client() {
    if (!configured)
      throw new GoogleStockError(
        503,
        'Conexão Google não configurada no servidor: defina GOOGLE_STOCK_CLIENT_ID e GOOGLE_STOCK_CLIENT_SECRET.',
      )
    return createClient?.() || new OAuth2Client(clientId, clientSecret, redirectUri)
  }
  return {
    configured,
    start(org: number, user: number): string {
      for (const [state, item] of pending)
        if (item.expiresAt < Date.now()) pending.delete(state)
      if (pending.size >= MAX_OAUTH_STATES)
        throw new GoogleStockError(429, 'Muitas conexões pendentes. Tente novamente.')
      const state = randomBytes(32).toString('base64url')
      pending.set(state, { org, user, expiresAt: Date.now() + STATE_LIFETIME_MS })
      return client().generateAuthUrl({
        state,
        scope: OAUTH_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: false,
      })
    },
    async complete(db: DatabaseSync, state: unknown, code: unknown): Promise<number> {
      const entry = typeof state === 'string' ? pending.get(state) : undefined
      if (typeof state === 'string') pending.delete(state)
      if (!entry || entry.expiresAt < Date.now() || typeof code !== 'string' || code.length > 4096)
        throw new GoogleStockError(401, 'Autorização Google ausente, expirada ou inválida.')
      const user = db
        .prepare("SELECT id FROM users WHERE id=? AND organization_id=? AND role='admin' AND active=1")
        .get(entry.user, entry.org)
      if (!user) throw new GoogleStockError(403, 'Administrador sem permissão ativa.')
      let refreshToken: string
      try {
        const result = await client().getToken(code)
        refreshToken = String(result.tokens.refresh_token || '')
      } catch {
        throw new GoogleStockError(502, 'O Google não concluiu a autorização. Tente conectar novamente.')
      }
      if (!refreshToken)
        throw new GoogleStockError(409, 'O Google não forneceu permissão offline. Remova o acesso anterior e conecte novamente.')
      const encrypted = encryptCredential(refreshToken, entry.org, 'google_stock_refresh_token')
      db.prepare(
        "INSERT INTO google_stock_connections (organization_id,refresh_token_enc,connected_by,connected_at) " +
          "VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(organization_id) DO UPDATE SET " +
          "refresh_token_enc=excluded.refresh_token_enc,connected_by=excluded.connected_by," +
          "connected_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP",
      ).run(entry.org, encrypted, entry.user)
      return entry.org
    },
    authorizedClient(db: DatabaseSync, organizationId: number): OAuth2Client {
      const row = db
        .prepare('SELECT refresh_token_enc token FROM google_stock_connections WHERE organization_id=?')
        .get(organizationId) as { token?: string } | undefined
      if (!row?.token) throw new GoogleStockError(409, 'Conecte sua conta Google antes de importar.')
      const value = decryptCredential(row.token, organizationId, 'google_stock_refresh_token')
      const authClient = client()
      authClient.setCredentials({ refresh_token: value })
      return authClient
    },
  }
}

function googleApiError(): never {
  // Avoid forwarding Google response details, which can contain private filenames,
  // OAuth codes, grant metadata or sensitive third-party diagnostic headers.
  throw new GoogleStockError(502, 'Falha na leitura do Google Drive/Sheets. Confira a permissão e a conexão.')
}

export function createGoogleStockSource(auth: OAuth2Client): GoogleStockSource {
  async function get<T>(url: string, params?: Record<string, string>): Promise<T> {
    try {
      const response = await auth.request<T>({ url, params, timeout: 20_000 })
      return response.data
    } catch {
      return googleApiError()
    }
  }
  return {
    async spreadsheetRows(spreadsheetId) {
      const target = encodeURIComponent("'Veiculos'!A1:T101")
      const result = await get<{ values?: unknown[][] }>(
        'https://sheets.googleapis.com/v4/spreadsheets/' +
          spreadsheetId +
          '/values/' +
          target,
        { valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS' },
      )
      return result.values || []
    },
    folderInfo(folderId) {
      return get<GoogleFile>('https://www.googleapis.com/drive/v3/files/' + folderId, {
        fields: 'id,name,mimeType,parents,modifiedTime',
      })
    },
    async listFiles(folderId) {
      const result = await get<{ files?: GoogleFile[]; nextPageToken?: string }>(
        'https://www.googleapis.com/drive/v3/files',
        {
          q: "'" + folderId + "' in parents and trashed=false",
          fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,parents)',
          pageSize: '100',
          orderBy: 'name',
        },
      )
      if (result.nextPageToken)
        throw new GoogleStockError(422, 'A pasta contém arquivos demais. Divida os arquivos em lotes menores.')
      return result.files || []
    },
    async download(fileId, sizeLimit) {
      try {
        const response = await auth.request<ArrayBuffer>({
          url: 'https://www.googleapis.com/drive/v3/files/' + fileId,
          params: { alt: 'media' },
          responseType: 'arraybuffer',
          timeout: 20_000,
        })
        const bytes = Buffer.from(response.data)
        if (!bytes.length || bytes.length > sizeLimit)
          throw new GoogleStockError(422, 'Arquivo excede o limite ou está vazio.')
        return bytes
      } catch (error) {
        if (error instanceof GoogleStockError) throw error
        return googleApiError()
      }
    },
  }
}
