// O servidor sempre responde JSON nas rotas de autenticação. Erros de proxy,
// API indisponível ou páginas HTML não devem aparecer como SyntaxError no login.
export class AuthResponseError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AuthResponseError'
    this.status = status
  }
}

const recovery =
  'Verifique se a API iniciou no terminal e teste http://127.0.0.1:3333/health/ready.'

export async function readAuthResponse<T>(response: Response): Promise<T> {
  let body: string
  try {
    body = await response.text()
  } catch {
    throw new AuthResponseError(`Falha ao receber a resposta da API. ${recovery}`, response.status)
  }
  if (!body.trim())
    throw new AuthResponseError(
      `A API retornou uma resposta vazia (HTTP ${response.status}). ${recovery}`,
      response.status,
    )
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    throw new AuthResponseError(
      `A API retornou uma resposta inválida (HTTP ${response.status}). ${recovery}`,
      response.status,
    )
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new AuthResponseError(
      `A API retornou um formato inesperado (HTTP ${response.status}). ${recovery}`,
      response.status,
    )
  const result = data as Record<string, unknown>
  if (!response.ok)
    throw new AuthResponseError(
      typeof result.error === 'string' && result.error.trim()
        ? result.error
        : `O servidor recusou a operação (HTTP ${response.status}).`,
      response.status,
    )
  return data as T
}

export async function authFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', ...options })
  } catch (error) {
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
      throw new AuthResponseError('A API demorou para responder. Verifique a conexão local.', 0)
    throw new AuthResponseError(`Não foi possível conectar à API do AutoFlow. ${recovery}`, 0)
  }
  return readAuthResponse<T>(response)
}
