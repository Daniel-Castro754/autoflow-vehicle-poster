import { useEffect, useRef } from 'react'

// Preserva os formulários e a lógica de cada drawer; gerencia apenas a experiência
// de teclado: foco inicial, Escape, ciclo Tab e retorno ao controle de origem.
export function DrawerFocusGuard({
  label,
  onClose,
}: {
  label: string
  onClose: () => void
}) {
  const marker = useRef<HTMLSpanElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const drawer = marker.current?.closest<HTMLElement>('.drawer')
    if (!drawer) return

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    drawer.setAttribute('role', 'dialog')
    drawer.setAttribute('aria-modal', 'true')
    drawer.setAttribute('aria-label', label)
    drawer.setAttribute('tabindex', '-1')

    const tabbable = () =>
      [...drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0 && !element.hasAttribute('inert'))

    const start = tabbable().find((element) => element.classList.contains('close'))
      || tabbable()[0]
    ;(start || drawer).focus()

    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = tabbable()
      if (!items.length) {
        event.preventDefault()
        drawer?.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === drawer)) {
        event.preventDefault()
        first.focus()
      }
    }
    drawer.addEventListener('keydown', keydown)
    return () => {
      drawer.removeEventListener('keydown', keydown)
      drawer.removeAttribute('role')
      drawer.removeAttribute('aria-modal')
      drawer.removeAttribute('aria-label')
      drawer.removeAttribute('tabindex')
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [label])

  return <span ref={marker} hidden aria-hidden="true" />
}
