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

export interface GenerationResult {
  description: string
  provider: 'gemini' | 'openai' | 'procedural'
}

const moneyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

export function generateProceduralDescription(vehicle: VehicleInput, tone: CopyTone = 'vendedor'): string {
  const kmFormatted = new Intl.NumberFormat('pt-BR').format(vehicle.km)
  const fullTitle = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ''}`
  const transmission = vehicle.transmission || 'Automático'
  const fuel = vehicle.fuelType || 'Flex'
  const condition = vehicle.condition || 'Muito bom'
  const color = vehicle.exteriorColor || 'Preto'
  const location = vehicle.location || 'Brasil'

  if (tone === 'profissional') {
    return [
      `🚗 ${fullTitle} em excelente estado de conservação.`,
      `• Quilometragem: ${kmFormatted} km`,
      `• Câmbio: ${transmission} | Combustível: ${fuel}`,
      `• Cor: ${color} | Condição: ${condition}`,
      `📍 Localização: ${location}`,
      'Veículo inspecionado, com procedência garantida e documentação pronta para transferência. Entre em contato para agendar uma visita e conferir as condições.'
    ].join('\n')
  }

  if (tone === 'amigável') {
    return [
      `✨ Procurando o carro ideal? Conheça este ${fullTitle}!`,
      `Com apenas ${kmFormatted} km rodados, câmbio ${transmission.toLowerCase()} e motor ${fuel.toLowerCase()}, ele une conforto, economia e estilo no dia a dia.`,
      `Pintura ${color.toLowerCase()} impecável, estado ${condition.toLowerCase()}.`,
      `📍 Disponível em ${location}.`,
      'Venha dar uma volta sem compromisso! Me chame no chat para mais fotos e detalhes.'
    ].join('\n')
  }

  if (tone === 'direto') {
    return [
      `${fullTitle} - ${kmFormatted} km`,
      `Câmbio: ${transmission} | Motor: ${fuel}`,
      `Cor: ${color} | Condição: ${condition}`,
      `Local: ${location}`,
      vehicle.price ? `Valor: ${moneyFormatter.format(vehicle.price)}` : '',
      'Pronto para rodar. Documentos em dia. Chame no direct para proposta.'
    ].filter(Boolean).join('\n')
  }

  // Padrão: Vendedor (alta conversão)
  const fipeCallout = (vehicle.fipeDiff && vehicle.fipeDiff > 500)
    ? `💰 R$ ${Math.round(vehicle.fipeDiff).toLocaleString('pt-BR')} ABAIXO DA TABELA FIPE (${vehicle.fipeDiffPercent}% de economia)!`
    : ''

  return [
    `🔥 OPORTUNIDADE: ${fullTitle}!`,
    fipeCallout,
    `Apenas ${kmFormatted} km rodados! Veículo com câmbio ${transmission.toLowerCase()}, econômico (${fuel.toLowerCase()}) e na cor ${color.toLowerCase()}.`,
    `Condição impecável (${condition.toLowerCase()}), revisado e pronto para a estrada.`,
    `📍 ${location}`,
    '👉 Não perca essa chance! Chame agora no chat para simular financiamento, avaliar seu usado ou agendar um test drive.'
  ].filter(Boolean).join('\n')
}

export async function generateVehicleDescription(
  vehicle: VehicleInput,
  options?: {
    tone?: CopyTone
    provider?: 'gemini' | 'openai' | 'auto'
    apiKey?: string
  }
): Promise<GenerationResult> {
  const tone: CopyTone = options?.tone || 'vendedor'
  const provider = options?.provider || 'auto'

  const geminiKey = (provider === 'gemini' ? options?.apiKey : undefined) || process.env.GEMINI_API_KEY || ''
  const openaiKey = (provider === 'openai' ? options?.apiKey : undefined) || process.env.OPENAI_API_KEY || ''

  const kmFormatted = new Intl.NumberFormat('pt-BR').format(vehicle.km)
  const fipeInfo = (vehicle.fipeDiff && vehicle.fipeDiff > 500 && vehicle.fipePrice)
    ? `- Cotação Tabela FIPE: R$ ${moneyFormatter.format(vehicle.fipePrice)} (ANUNCIADO R$ ${Math.round(vehicle.fipeDiff).toLocaleString('pt-BR')} ABAIXO DA FIPE / ${vehicle.fipeDiffPercent}% DE ECONOMIA REAL)`
    : ''

  const prompt = `
Você é um especialista em marketing automotivo para Facebook Marketplace no Brasil.
Gere uma descrição atraente no tom "${tone}" para o seguinte veículo:
- Ano/Marca/Modelo: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim || ''}
- Quilometragem: ${kmFormatted} km
- Câmbio: ${vehicle.transmission || 'Automático'}
- Combustível: ${vehicle.fuelType || 'Flex'}
- Cor externa: ${vehicle.exteriorColor || 'Não especificada'}
- Cor interna: ${vehicle.interiorColor || 'Não especificada'}
- Carroceria: ${vehicle.bodyType || 'Sedã'}
- Condição: ${vehicle.condition || 'Muito bom'}
- Localização: ${vehicle.location || 'Brasil'}
${vehicle.price ? `- Preço anunciado: ${moneyFormatter.format(vehicle.price)}` : ''}
${fipeInfo}

REGRAS:
1. Escreva em português do Brasil.
2. Máximo de 500 caracteres.
3. Destaque os pontos fortes do veículo de forma atrativa para o Marketplace.${fipeInfo ? ' Dê grande destaque ao desconto real abaixo da FIPE logo no início!' : ''}
4. Inclua uma chamada clara para ação (CTA) no final.
5. NÃO invente opcionais ou itens não informados.
6. Retorne APENAS o texto do anúncio, sem explicações adicionais ou aspas.
`.trim()

  // 1. Tentar Gemini se disponível
  if (geminiKey && (provider === 'auto' || provider === 'gemini')) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 300,
            },
          }),
        }
      )

      if (response.ok) {
        const data = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        }
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
        if (text) {
          return { description: text, provider: 'gemini' }
        }
      } else {
        console.warn(`[AutoFlow AI] Gemini API respondeu com status ${response.status}`)
      }
    } catch (err) {
      console.warn('[AutoFlow AI] Falha na chamada ao Gemini API:', err instanceof Error ? err.message : err)
    }
  }

  // 2. Tentar OpenAI se disponível
  if (openaiKey && (provider === 'auto' || provider === 'openai')) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
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
          return { description: text, provider: 'openai' }
        }
      } else {
        console.warn(`[AutoFlow AI] OpenAI API respondeu com status ${response.status}`)
      }
    } catch (err) {
      console.warn('[AutoFlow AI] Falha na chamada à OpenAI API:', err instanceof Error ? err.message : err)
    }
  }

  // 3. Fallback procedural inteligente (100% offline e imediato)
  return {
    description: generateProceduralDescription(vehicle, tone),
    provider: 'procedural',
  }
}
