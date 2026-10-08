import { useEffect, useRef, useState } from 'react'
import { loadGoogleIdentity } from './google-identity'

type LinkRequest = { linkRequired: true; linkToken: string; email: string }
type LoginResult = { token: string } | LinkRequest

async function googleRequest<T>(apiUrl: string, path: string, body?: object, signal?: AbortSignal) {
  const response = await fetch(`${apiUrl}/auth/google${path}`, {
    method: body ? 'POST' : 'GET',
    ...(body
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
    signal: signal || AbortSignal.timeout(20000),
    cache: 'no-store',
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Não foi possível entrar com Google.')
  return data as T
}

export default function GoogleSignIn({
  apiUrl,
  disabled,
  theme,
  onSuccess,
  onBusyChange,
}: {
  apiUrl: string
  disabled: boolean
  theme: 'light' | 'dark'
  onSuccess: (token: string) => void
  onBusyChange: (busy: boolean) => void
}) {
  const button = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const disabledRef = useRef(disabled)
  const mounted = useRef(false)
  const [status, setStatus] = useState<'loading' | 'disabled' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [pendingLink, setPendingLink] = useState<LinkRequest | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    disabledRef.current = disabled
  }, [disabled])

  useEffect(() => {
    let active = true
    mounted.current = true
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
    const container = button.current
    async function prepare() {
      try {
        const config = await googleRequest<{ enabled: boolean; clientId: string }>(
          apiUrl,
          '/config',
          undefined,
          signal,
        )
        if (!active) return
        if (!config.enabled) {
          setStatus('disabled')
          return
        }
        const identity = await loadGoogleIdentity()
        const challenge = await googleRequest<{ nonce: string; challengeToken: string }>(
          apiUrl,
          '/challenge',
          {},
          signal,
        )
        if (!active || !container) return
        identity.initialize({
          client_id: config.clientId,
          nonce: challenge.nonce,
          auto_select: false,
          ux_mode: 'popup',
          callback: ({ credential }) => {
            if (!active || busy.current || disabledRef.current) return
            busy.current = true
            onBusyChange(true)
            setError('')
            let authenticated = false
            void googleRequest<LoginResult>(apiUrl, '', {
              credential,
              challengeToken: challenge.challengeToken,
            })
              .then((result) => {
                if (!active) return
                if ('token' in result) {
                  onSuccess(result.token)
                  authenticated = true
                } else setPendingLink(result)
              })
              .catch((failure) => {
                if (!active) return
                setStatus('error')
                setError(failure instanceof Error ? failure.message : 'Falha no acesso com Google.')
              })
              .finally(() => {
                busy.current = false
                if (active && !authenticated) onBusyChange(false)
              })
          },
        })
        // No One Tap or automatic sign-in: opening/closing the popup leaves password login usable.
        container.replaceChildren()
        identity.renderButton(container, {
          theme: theme === 'dark' ? 'filled_black' : 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          locale: 'pt-BR',
          width: Math.min(390, container.parentElement?.clientWidth || 300),
        })
        setStatus('ready')
      } catch (failure) {
        if (!active) return
        setStatus('error')
        setError(
          failure instanceof Error ? failure.message : 'O acesso com Google está indisponível.',
        )
      }
    }
    void prepare()
    return () => {
      active = false
      mounted.current = false
      controller.abort()
      container?.replaceChildren()
    }
  }, [apiUrl, theme, onSuccess, onBusyChange, attempt])

  function retry() {
    setError('')
    setPendingLink(null)
    setStatus('loading')
    setAttempt((value) => value + 1)
  }

  async function confirmLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!pendingLink || disabled || busy.current) return
    const password = new FormData(event.currentTarget).get('googlePassword')
    event.currentTarget.reset()
    busy.current = true
    onBusyChange(true)
    setError('')
    let authenticated = false
    try {
      const result = await googleRequest<{ token: string }>(apiUrl, '/link', {
        linkToken: pendingLink.linkToken,
        password,
      })
      if (mounted.current) {
        onSuccess(result.token)
        authenticated = true
      }
    } catch (failure) {
      if (mounted.current) {
        setPendingLink(null)
        setStatus('error')
        setError(
          failure instanceof Error ? failure.message : 'Não foi possível conectar sua conta.',
        )
      }
    } finally {
      busy.current = false
      if (mounted.current && !authenticated) onBusyChange(false)
    }
  }

  if (status === 'disabled') return null
  return (
    <section className="google-sign-in" aria-label="Acesso com Google" aria-busy={disabled}>
      <div className="login-divider">
        <span>ou</span>
      </div>
      <div
        ref={button}
        className="google-sign-in-button"
        hidden={status !== 'ready' || Boolean(pendingLink)}
        inert={disabled}
      />
      {status === 'loading' && <p role="status">Carregando acesso com Google...</p>}
      {disabled && status === 'ready' && <p role="status">Validando acesso...</p>}
      {pendingLink && (
        <form className="google-link-form" onSubmit={(event) => void confirmLink(event)}>
          <p>
            Para conectar <strong>{pendingLink.email}</strong>, confirme sua senha atual do
            AutoFlow. Nas próximas vezes, basta entrar com Google.
          </p>
          <label>
            Senha do AutoFlow
            <input
              type="password"
              name="googlePassword"
              autoComplete="current-password"
              required
              maxLength={512}
              disabled={disabled}
            />
          </label>
          <button className="primary" disabled={disabled}>
            Conectar Google e entrar
          </button>
          <button type="button" className="google-retry" onClick={retry} disabled={disabled}>
            Cancelar conexão
          </button>
        </form>
      )}
      {error && (
        <div className="auth-error" role="alert">
          {error}
        </div>
      )}
      {status === 'error' && (
        <button type="button" className="google-retry" onClick={retry} disabled={disabled}>
          Tentar Google novamente
        </button>
      )}
      {status === 'ready' && !pendingLink && (
        <p>Use a conta Google com o mesmo e-mail cadastrado no AutoFlow.</p>
      )}
    </section>
  )
}
