import { useState } from 'react'
import { TelegramCommanderSettings } from './TelegramCommanderSettings'
import { CommanderPermissionSettings } from './CommanderPermissionSettings'
import { CommanderDiagnosticSettings } from './CommanderDiagnosticSettings'

type Api = <T = Record<string, unknown>>(path: string, options?: RequestInit) => Promise<T>
const sections = [
  { id: 'telegram', label: 'Telegram e IA' },
  { id: 'permissions', label: 'Permissões' },
  { id: 'diagnostics', label: 'Diagnóstico' },
] as const

export function CommanderSettingsPanel({ api }: { api: Api }) {
  const [active, setActive] = useState<(typeof sections)[number]['id']>('telegram')
  return (
    <section className="commander-panel" aria-labelledby="commander-panel-title">
      <h3 id="commander-panel-title">AI Commander</h3>
      <nav className="commander-navigation" aria-label="Configurações do AI Commander">
        {sections.map(section => (
          <button
            key={section.id}
            type="button"
            className="secondary"
            aria-pressed={active === section.id}
            aria-controls={'commander-panel-' + section.id}
            onClick={() => setActive(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      {/* Keep the settings mounted so navigating does not discard unsaved edits. */}
      <div id="commander-panel-telegram" hidden={active !== 'telegram'}>
        <TelegramCommanderSettings api={api} />
      </div>
      <div id="commander-panel-permissions" hidden={active !== 'permissions'}>
        <CommanderPermissionSettings api={api} />
      </div>
      <div id="commander-panel-diagnostics" hidden={active !== 'diagnostics'}>
        <CommanderDiagnosticSettings api={api} />
      </div>
    </section>
  )
}
