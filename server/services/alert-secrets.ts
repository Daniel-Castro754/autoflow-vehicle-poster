import { isIP } from 'node:net'

/**
 * Block obvious local/internal endpoints and insecure URLs. This is a first-line
 * defense, not a substitute for a network-level egress firewall / DNS pinning.
 */
export function validateWebhookAddress(value: string): string {
  const input = value.trim()
  if (!input) return ''
  if (input.length > 2048 || Array.from(input).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
    throw new Error('A URL do webhook é muito longa ou contém caracteres inválidos.')
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('Informe uma URL HTTPS válida para o webhook.')
  }
  const host = url.hostname.replace(/\.$/, '').toLowerCase()
  const blockedSuffix = /(?:^|\.)(?:localhost|local|internal|lan|home|arpa)$/
  if (
    url.protocol !== 'https:' ||
    url.username || url.password ||
    !host.includes('.') || isIP(host) !== 0 ||
    blockedSuffix.test(host) || host === 'metadata.google.internal' ||
    url.hash || (url.port && url.port !== '443')
  ) {
    throw new Error('Use um domínio público HTTPS sem credenciais, IP literal ou porta alternativa.')
  }
  return url.toString()
}

/** Telegram accepts numeric chat identifiers and public channel names. */
export function validateTelegramDestination(token: string, chat: string) {
  if (token && (token.length > 160 || !/^\d{5,16}:[a-zA-Z0-9_-]{20,}$/.test(token)))
    throw new Error('Formato de token do bot Telegram inválido.')
  if (chat && (chat.length > 128 || !/^(?:-?\d{1,30}|@[a-zA-Z0-9_]{5,64})$/.test(chat)))
    throw new Error('ID do chat Telegram inválido.')
}
