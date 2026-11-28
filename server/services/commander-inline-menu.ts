import { createHmac, timingSafeEqual } from 'node:crypto'

export const commanderMenuRows = [
  [{ action: 'status', label: '📊 Status geral' }, { action: 'stock', label: '🚗 Estoque', question: 'Quantos veículos estão em estoque? Resuma os disponíveis.' }],
  [{ action: 'profiles', label: '👥 Perfis', question: 'Qual é a situação dos perfis e de seus consumidores?' }, { action: 'queue', label: '📋 Fila', question: 'Qual é a situação da fila e quais trabalhos aguardam revisão?' }],
  [{ action: 'diagnosis', label: '⚠️ Diagnóstico', question: 'Quais problemas operacionais estão comprovados e quais os próximos passos?' }, { action: 'performance', label: '📈 Desempenho', question: 'Resuma o desempenho operacional registrado hoje e as limitações dos dados.' }],
  [{ action: 'memory', label: '🧠 Memória' }, { action: 'help', label: '❔ Ajuda' }],
  [{ action: 'supervisao', label: '🔎 Supervisão' }, { action: 'chat', label: '💬 Conversar com a IA', requiresAi: true }],
] as const

export type MenuScope = { organizationId: number; chatId: string; userId: string; revision: number; token: string }
type MenuItem = (typeof commanderMenuRows)[number][number]
const items: readonly MenuItem[] = commanderMenuRows.flat()
const ttlSeconds = 300
const signature = (scope: MenuScope, action: string, expires: string) => createHmac('sha256', scope.token)
  .update(JSON.stringify(['commander-menu-v1', scope.organizationId, scope.chatId, scope.userId, scope.revision, action, expires]))
  .digest('hex').slice(0, 32)
const needsAi = (item: MenuItem) => 'question' in item || 'requiresAi' in item

export function buildCommanderMenu(scope: MenuScope, aiEnabled: boolean, now: number) {
  const expires = (Math.floor(now / 1000) + ttlSeconds).toString(36)
  return commanderMenuRows.map(row => row.filter(item => aiEnabled || !needsAi(item)).map(item => ({
    text: item.label,
    callback_data: 'ac1:' + item.action + ':' + expires + ':' + signature(scope, item.action, expires),
  }))).filter(row => row.length > 0)
}

export function verifyCommanderMenu(data: unknown, scope: MenuScope, aiEnabled: boolean, now: number): MenuItem | null {
  if (typeof data !== 'string' || Buffer.byteLength(data) > 64) return null
  const match = /^ac1:([a-z]+):([0-9a-z]{1,10}):([a-f0-9]{32})$/.exec(data)
  if (!match) return null
  const [, action, expires, mac] = match
  const item = items.find(entry => entry.action === action)
  if (!item || (!aiEnabled && needsAi(item))) return null
  const expiry = Number.parseInt(expires, 36)
  const current = Math.floor(now / 1000)
  if (!Number.isSafeInteger(expiry) || expiry <= current || expiry > current + ttlSeconds) return null
  const expected = signature(scope, action, expires)
  return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex')) ? item : null
}
