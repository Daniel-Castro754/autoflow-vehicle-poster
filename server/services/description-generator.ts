import { logger } from '../lib/logger.ts'

export interface VehicleInput {
  year: number
  make: string
  model: string
  trim?: string
  km: number
  price?: number
  transmission?: string
  fuelType?: string
  bodyType?: string
  exteriorColor?: string
  interiorColor?: string
  condition?: string
  location?: string
  description?: string
  fipePrice?: number
  fipeDiff?: number
  fipeDiffPercent?: number
  fipeBadge?: string
}

export type CopyTone = 'vendedor' | 'profissional' | 'amigável' | 'direto'
export type AIProviderChoice = 'gemini' | 'openai' | 'auto' | 'procedural'

export interface AIProviderSettings {
  aiProvider?: string
  geminiApiKey?: string
  openaiApiKey?: string
}

export function resolveAIProviderSettings(settings?: AIProviderSettings) {
  const requestedProvider = settings?.aiProvider
  const configuredProvider: AIProviderChoice =
    requestedProvider === 'gemini' ||
    requestedProvider === 'openai' ||
    requestedProvider === 'procedural'
      ? requestedProvider
      : 'auto'
  const geminiApiKey = settings?.geminiApiKey?.trim() || process.env.GEMINI_API_KEY || ''
  const openaiApiKey = settings?.openaiApiKey?.trim() || process.env.OPENAI_API_KEY || ''
  return {
    provider: configuredProvider,
    apiKeys:
      configuredProvider === 'gemini'
        ? { gemini: geminiApiKey }
        : configuredProvider === 'openai'
          ? { openai: openaiApiKey }
          : configuredProvider === 'auto'
            ? { gemini: geminiApiKey, openai: openaiApiKey }
            : {},
  }
}

export interface GenerationResult {
  description: string
  provider: 'gemini' | 'openai' | 'procedural'
  attemptedProviders?: Array<'gemini' | 'openai'>
  fallbackReason?: string
}

const moneyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

export function generateProceduralDescription(
  vehicle: VehicleInput,
  tone: CopyTone = 'vendedor',
): string {
  const fullTitle = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ''}`
  const details = [
    vehicle.km > 0 ? `Quilometragem: ${new Intl.NumberFormat('pt-BR').format(vehicle.km)} km` : '',
    vehicle.transmission ? `Câmbio: ${vehicle.transmission}` : '',
    vehicle.fuelType ? `Combustível: ${vehicle.fuelType}` : '',
    vehicle.exteriorColor ? `Cor externa: ${vehicle.exteriorColor}` : '',
    vehicle.interiorColor ? `Cor interna: ${vehicle.interiorColor}` : '',
    vehicle.condition ? `Condição informada: ${vehicle.condition}` : '',
    vehicle.price ? `Preço: ${moneyFormatter.format(vehicle.price)}` : '',
    vehicle.location ? `Localização: ${vehicle.location}` : '',
  ].filter(Boolean)
  const fipeCallout =
    vehicle.fipeDiff && vehicle.fipeDiff > 500
      ? `Diferença informada em relação à FIPE: R$ ${Math.round(vehicle.fipeDiff).toLocaleString('pt-BR')}${vehicle.fipeDiffPercent ? ` (${vehicle.fipeDiffPercent}%)` : ''}.`
      : ''
  const introduction =
    tone === 'amigável'
      ? `Conheça: ${fullTitle}.`
      : tone === 'direto'
        ? fullTitle
        : tone === 'profissional'
          ? `Anúncio: ${fullTitle}.`
          : `À venda: ${fullTitle}.`
  return [
    introduction,
    ...details,
    fipeCallout,
    tone === 'direto'
      ? 'Entre em contato para mais informações.'
      : 'Fale conosco para tirar dúvidas e combinar uma visita.',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function generateVehicleDescription(
  vehicle: VehicleInput,
  options?: {
    tone?: CopyTone
    provider?: AIProviderChoice
    apiKey?: string
    apiKeys?: Partial<Record<'gemini' | 'openai', string>>
  },
): Promise<GenerationResult> {
  const tone: CopyTone = options?.tone || 'vendedor'
  const provider = options?.provider || 'auto'

  const geminiKey =
    (provider === 'gemini' ? options?.apiKey : undefined) ||
    options?.apiKeys?.gemini ||
    process.env.GEMINI_API_KEY ||
    ''
  const openaiKey =
    (provider === 'openai' ? options?.apiKey : undefined) ||
    options?.apiKeys?.openai ||
    process.env.OPENAI_API_KEY ||
    ''
  const attemptedProviders: Array<'gemini' | 'openai'> = []
  const failures: string[] = []

  const fipeInfo =
    vehicle.fipeDiff && vehicle.fipeDiff > 500 && vehicle.fipePrice
      ? `- Cotação Tabela FIPE informada: ${moneyFormatter.format(vehicle.fipePrice)}; diferença informada: R$ ${Math.round(vehicle.fipeDiff).toLocaleString('pt-BR')}${vehicle.fipeDiffPercent ? ` (${vehicle.fipeDiffPercent}%)` : ''}`
      : ''

  const providedFacts = [
    vehicle.year && vehicle.make && vehicle.model
      ? `- Ano/Marca/Modelo: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim || ''}`
      : '',
    vehicle.km > 0
      ? `- Quilometragem: ${new Intl.NumberFormat('pt-BR').format(vehicle.km)} km`
      : '',
    vehicle.transmission ? `- Câmbio: ${vehicle.transmission}` : '',
    vehicle.fuelType ? `- Combustível: ${vehicle.fuelType}` : '',
    vehicle.exteriorColor ? `- Cor externa: ${vehicle.exteriorColor}` : '',
    vehicle.interiorColor ? `- Cor interna: ${vehicle.interiorColor}` : '',
    vehicle.bodyType ? `- Carroceria: ${vehicle.bodyType}` : '',
    vehicle.condition ? `- Condição informada: ${vehicle.condition}` : '',
    vehicle.location ? `- Localização: ${vehicle.location}` : '',
    vehicle.price ? `- Preço anunciado: ${moneyFormatter.format(vehicle.price)}` : '',
  ].filter(Boolean)
  const prompt = `
Você é um especialista em marketing automotivo para Facebook Marketplace no Brasil.
Gere uma descrição atraente no tom "${tone}" usando somente os dados abaixo:
${providedFacts.length ? providedFacts.join('\n') : '- Nenhum dado adicional informado'}
${fipeInfo}

REGRAS:
1. Escreva em português do Brasil.
2. Máximo de 500 caracteres.
3. Não preencha lacunas nem deduza dados. Use apenas os fatos informados acima.
4. Não afirme estado de conservação, manutenção, histórico, procedência, documentação, opcionais, garantia, disponibilidade, economia ou desempenho se isso não estiver explicitamente informado.
5. Não diga que o veículo está revisado, impecável, pronto para rodar ou abaixo da FIPE a menos que esses fatos estejam explicitamente informados.
6. Inclua uma chamada neutra para contato, sem prometer condições ou serviços.
7. Retorne APENAS o texto do anúncio, sem explicações adicionais ou aspas.
`.trim()

  // 1. Tentar Gemini se disponível
  if (geminiKey && (provider === 'auto' || provider === 'gemini')) {
    attemptedProviders.push('gemini')
    try {
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          method: 'POST',
          signal: AbortSignal.timeout(12000),
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 300,
            },
          }),
        },
      )

      if (response.ok) {
        const data = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        }
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
        if (text) {
          return { description: text, provider: 'gemini', attemptedProviders }
        }
        failures.push('Gemini retornou uma resposta vazia')
      } else {
        logger.warn('AutoFlowAI', `Gemini API respondeu com status ${response.status}`)
        failures.push('Gemini indisponível (HTTP ' + response.status + ')')
      }
    } catch (err) {
      logger.warn('AutoFlowAI', 'Falha na chamada ao Gemini API', {
        name: err instanceof Error ? err.name : 'unknown',
      })
      failures.push('Gemini indisponível por falha de rede')
    }
  }

  // 2. Tentar OpenAI se disponível
  if (openaiKey && (provider === 'auto' || provider === 'openai')) {
    attemptedProviders.push('openai')
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(12000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.7,
        }),
      })

      if (response.ok) {
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const text = data.choices?.[0]?.message?.content?.trim()
        if (text) {
          return {
            description: text,
            provider: 'openai',
            attemptedProviders,
            ...(failures.length ? { fallbackReason: failures.join('; ') } : {}),
          }
        }
        failures.push('OpenAI retornou uma resposta vazia')
      } else {
        logger.warn('AutoFlowAI', `OpenAI API respondeu com status ${response.status}`)
        failures.push('OpenAI indisponível (HTTP ' + response.status + ')')
      }
    } catch (err) {
      logger.warn('AutoFlowAI', 'Falha na chamada à OpenAI API', {
        name: err instanceof Error ? err.name : 'unknown',
      })
      failures.push('OpenAI indisponível por falha de rede')
    }
  }

  // 3. Fallback procedural inteligente (100% offline e imediato)
  return {
    description: generateProceduralDescription(vehicle, tone),
    provider: 'procedural',
    attemptedProviders,
    ...(provider === 'procedural'
      ? {}
      : {
          fallbackReason:
            failures.join('; ') || 'Nenhuma chave disponível para o provedor selecionado.',
        }),
  }
}
