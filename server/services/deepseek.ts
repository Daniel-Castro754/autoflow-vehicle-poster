// The API key is only sent to the fixed official HTTPS endpoint.
export type DeepseekModel = 'deepseek-flash' | 'deepseek-v4-pro'
export async function deepseekText(
  apiKey: string,
  prompt: string,
  options: { model?: DeepseekModel; maxTokens?: number } = {},
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const model = options.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash'
  if (!apiKey.trim() || apiKey.length > 4096 || prompt.length > 32000)
    return { ok: false, reason: 'Credencial ou entrada inválida.' }
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }],
        max_tokens: Math.min(1000, Math.max(8, Math.floor(options.maxTokens || 300))),
        stream: false,
      }),
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      return { ok: false, reason: 'DeepSeek indisponível (HTTP ' + response.status + ').' }
    }
    const body = await response.json() as { choices?: Array<{finish_reason?:string;message?:{content?:unknown}}> }
    const choice = body.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string' || !content.trim() || choice?.finish_reason !== 'stop')
      return { ok: false, reason: 'DeepSeek retornou resposta vazia ou incompleta.' }
    return { ok: true, text: content.trim().slice(0, 4000) }
  } catch {
    return { ok: false, reason: 'DeepSeek indisponível por falha de rede ou tempo limite.' }
  }
}
