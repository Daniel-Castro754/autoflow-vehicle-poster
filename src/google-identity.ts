type GoogleIdentity = {
  initialize: (options: {
    client_id: string
    nonce: string
    auto_select: boolean
    ux_mode: 'popup'
    callback: (response: { credential: string }) => void
  }) => void
  renderButton: (
    element: HTMLElement,
    options: {
      theme: 'outline' | 'filled_black'
      size: 'large'
      text: 'signin_with'
      shape: 'rectangular'
      locale: string
      width: number
    },
  ) => void
}

let pending: Promise<GoogleIdentity> | undefined
export function loadGoogleIdentity() {
  const identity = () =>
    (window as Window & { google?: { accounts?: { id?: GoogleIdentity } } }).google?.accounts?.id
  const ready = identity()
  if (ready) return Promise.resolve(ready)
  if (pending) return pending
  pending = new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.referrerPolicy = 'strict-origin-when-cross-origin'
    const fail = () => {
      window.clearTimeout(timeout)
      script.remove()
      pending = undefined
      reject(
        new Error(
          'O Google não carregou. Verifique a conexão e permita a janela de acesso no navegador.',
        ),
      )
    }
    const timeout = window.setTimeout(fail, 15000)
    script.onerror = fail
    script.onload = () => {
      const api = identity()
      if (!api) return fail()
      window.clearTimeout(timeout)
      resolve(api)
    }
    document.head.appendChild(script)
  })
  return pending
}
