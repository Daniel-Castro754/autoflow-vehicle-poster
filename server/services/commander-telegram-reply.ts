type Credentials = { telegramBotToken: string; telegramChatId: string }
export type CommanderReplyOptions = { format?: boolean; menu?: { messageId: number; username: string } }
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Only locally generated tags are allowed. Model text never becomes raw HTML.
export function formatCommanderReply(raw: string) {
  const text = raw.slice(0, 3900)
  let html = '', plain = '', offset = 0
  for (const match of text.matchAll(/\*\*([^*\r\n]+)\*\*|`([^`\r\n]+)`/g)) {
    const start = match.index ?? 0
    const before = text.slice(offset, start)
    const value = match[1] ?? match[2]
    const tag = match[1] !== undefined ? 'b' : 'code'
    html += escape(before) + '<' + tag + '>' + escape(value) + '</' + tag + '>'
    plain += before + value
    offset = start + match[0].length
  }
  return { html: html + escape(text.slice(offset)), plain: plain + text.slice(offset) }
}

export async function sendCommanderReply(text: string, credentials: Credentials, options: CommanderReplyOptions = {}) {
  const formatted = options.format ? formatCommanderReply(text) : null
  const payload = {
    chat_id: credentials.telegramChatId,
    text: formatted?.html ?? text.slice(0, 3900),
    link_preview_options: { is_disabled: true },
    ...(formatted ? { parse_mode: 'HTML' } : {}),
  }
  const send = async (body: Record<string, unknown>) => {
    const response = await fetch('https://api.telegram.org/bot' + credentials.telegramBotToken + '/sendMessage', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const result = await response.json() as { ok?: boolean; description?: string }
    return { ok: response.ok && result.ok === true, status: response.status, description: result.description }
  }
  try {
    const result = await send(payload)
    // Only retry an explicit parse rejection, never an ambiguous network failure.
    if (formatted && result.status === 400 && /parse entities|unsupported start tag/i.test(result.description ?? '')) {
      return (await send({ chat_id: payload.chat_id, text: formatted.plain, link_preview_options: payload.link_preview_options })).ok
    }
    return result.ok
  } catch { return false }
}
