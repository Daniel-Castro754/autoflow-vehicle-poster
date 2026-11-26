type Credentials = { telegramBotToken: string; telegramChatId: string }
export type CommanderReplyOptions = { format?: boolean; menu?: { messageId: number; username: string; aiEnabled: boolean } }
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
  const menu = options.menu
  const keyboard = menu ? [
    [{ text: '/status@' + menu.username }, { text: '/ajuda@' + menu.username }],
    ...(menu.aiEnabled ? [
      [{ text: '/ia@' + menu.username + ' Quantos veículos estão em estoque?' }],
      [{ text: '/ia@' + menu.username + ' Qual é a situação dos perfis?' }],
      [{ text: '/ia@' + menu.username + ' Quais trabalhos aguardam revisão?' }],
    ] : []),
  ] : null
  const payload = {
    chat_id: credentials.telegramChatId,
    text: formatted?.html ?? text.slice(0, 3900),
    link_preview_options: { is_disabled: true },
    ...(formatted ? { parse_mode: 'HTML' } : {}),
    ...(menu && keyboard ? {
      reply_parameters: { message_id: menu.messageId, allow_sending_without_reply: false },
      reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: true, selective: true },
    } : {}),
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
      const { parse_mode: _parseMode, ...plainPayload } = payload
      void _parseMode
      return (await send({ ...plainPayload, text: formatted.plain })).ok
    }
    return result.ok
  } catch { return false }
}
