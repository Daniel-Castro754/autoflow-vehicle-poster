export interface FipeResult {
  price: number
  code: string
  referenceMonth: string
  modelName: string
  brandName: string
  yearModel: number
  fetchedAt: string
}

export interface FipeComparison {
  vehiclePrice: number
  fipePrice: number
  diff: number
  diffPercent: number
  status: 'below' | 'average' | 'above'
  badgeText: string
  salesPitch: string
}

// Mapa rápido de IDs de marcas mais populares da FIPE para velocidade máxima (<50ms)
const POPULAR_BRANDS: Record<string, string> = {
  audi: '6',
  bmw: '7',
  chery: '136',
  caoa: '136',
  chevrolet: '23',
  gm: '23',
  citroen: '28',
  fiat: '21',
  ford: '22',
  honda: '25',
  hyundai: '26',
  jeep: '29',
  kia: '31',
  mercedes: '39',
  'mercedes-benz': '39',
  mitsubishi: '41',
  nissan: '43',
  peugeot: '44',
  ram: '185',
  renault: '44',
  toyota: '56',
  volkswagen: '59',
  vw: '59',
  volvo: '58',
}

// Cache em memória durante o ciclo de execução do servidor
const fipeMemoryCache = new Map<string, FipeResult>()

/**
 * Consulta a Tabela FIPE pública com timeout e fallback silencioso.
 */
export async function lookupFipePrice(params: {
  make: string
  model: string
  year: number
  timeoutMs?: number
}): Promise<FipeResult | null> {
  const { make, model, year, timeoutMs = 4500 } = params
  if (!make || !model || !year) return null

  const cacheKey = `${make.toLowerCase().trim()}_${model.toLowerCase().trim()}_${year}`
  if (fipeMemoryCache.has(cacheKey)) {
    return fipeMemoryCache.get(cacheKey)!
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const cleanMake = make.toLowerCase().trim()
    let brandCode = POPULAR_BRANDS[cleanMake]

    // Se não estiver no mapa rápido, busca dinamicamente
    if (!brandCode) {
      const brandsRes = await fetch('https://parallelum.com.br/fipe/api/v1/carros/marcas', {
        signal: controller.signal,
      })
      if (!brandsRes.ok) return null
      const brands = (await brandsRes.json()) as Array<{ codigo: string; nome: string }>
      const found = brands.find(
        (b) =>
          b.nome.toLowerCase().includes(cleanMake) ||
          cleanMake.includes(b.nome.toLowerCase())
      )
      if (!found) return null
      brandCode = found.codigo
    }

    // Busca os modelos da marca
    const modelsRes = await fetch(
      `https://parallelum.com.br/fipe/api/v1/carros/marcas/${brandCode}/modelos`,
      { signal: controller.signal }
    )
    if (!modelsRes.ok) return null
    const modelsData = (await modelsRes.json()) as {
      modelos: Array<{ codigo: number; nome: string }>
    }

    if (!modelsData.modelos || !modelsData.modelos.length) return null

    // Encontra o modelo por correspondência de termos
    const cleanModel = model.toLowerCase().trim()
    const modelTerms = cleanModel.split(/\s+/).filter((t) => t.length > 1)

    // Primeiro tenta correspondência onde todos os termos estejam presentes
    let matchedModel = modelsData.modelos.find((m) => {
      const name = m.nome.toLowerCase()
      return modelTerms.every((term) => name.includes(term))
    })

    // Fallback: primeiro termo principal (ex: "Corolla", "Civic", "Onix", "Compass")
    if (!matchedModel && modelTerms.length > 0) {
      const primaryTerm = modelTerms[0]
      matchedModel = modelsData.modelos.find((m) =>
        m.nome.toLowerCase().includes(primaryTerm)
      )
    }

    if (!matchedModel) return null

    // Busca os anos disponíveis para o modelo
    const yearsRes = await fetch(
      `https://parallelum.com.br/fipe/api/v1/carros/marcas/${brandCode}/modelos/${matchedModel.codigo}/anos`,
      { signal: controller.signal }
    )
    if (!yearsRes.ok) return null
    const years = (await yearsRes.json()) as Array<{ codigo: string; nome: string }>

    // Encontra o ano desejado (código começa com o ano, ex: '2024-1' ou '2024-6')
    const targetYearStr = String(year)
    const matchedYear =
      years.find((y) => y.codigo.startsWith(targetYearStr)) ||
      years.find((y) => y.nome.includes(targetYearStr))

    if (!matchedYear) return null

    // Busca o preço final
    const priceRes = await fetch(
      `https://parallelum.com.br/fipe/api/v1/carros/marcas/${brandCode}/modelos/${matchedModel.codigo}/anos/${matchedYear.codigo}`,
      { signal: controller.signal }
    )
    if (!priceRes.ok) return null
    const priceData = (await priceRes.json()) as {
      Valor?: string
      Marca?: string
      Modelo?: string
      AnoModelo?: number
      CodigoFipe?: string
      MesReferencia?: string
    }

    if (!priceData.Valor) return null

    // Converte 'R$ 156.728,00' para 156728
    const rawNumber = priceData.Valor.replace(/[^\d]/g, '')
    const parsedPrice = Math.round(Number(rawNumber) / 100)

    if (isNaN(parsedPrice) || parsedPrice <= 0) return null

    const result: FipeResult = {
      price: parsedPrice,
      code: priceData.CodigoFipe || '',
      referenceMonth: priceData.MesReferencia || '',
      modelName: priceData.Modelo || matchedModel.nome,
      brandName: priceData.Marca || make,
      yearModel: priceData.AnoModelo || year,
      fetchedAt: new Date().toISOString(),
    }

    fipeMemoryCache.set(cacheKey, result)
    return result
  } catch {
    // Timeout ou erro de rede: retorna nulo sem interromper o fluxo operacional
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Compara o preço do veículo com a cotação oficial da FIPE e gera métricas e gatilhos de vendas.
 */
export function compareWithFipe(vehiclePrice: number, fipePrice: number): FipeComparison {
  const diff = fipePrice - vehiclePrice
  const diffPercent = fipePrice > 0 ? Math.round((diff / fipePrice) * 100) : 0

  let status: 'below' | 'average' | 'above' = 'average'
  let badgeText = 'Na média da FIPE'
  let salesPitch = 'Preço justo e competitivo alinhado com a cotação oficial da Tabela FIPE.'

  if (diff > 500) {
    status = 'below'
    const formattedDiff = diff.toLocaleString('pt-BR')
    badgeText = `R$ ${formattedDiff} abaixo da FIPE (-${diffPercent}%)`
    salesPitch = `🔥 OPORTUNIDADE: Anunciado por R$ ${formattedDiff} ABAIXO da Tabela FIPE oficial (${diffPercent}% de desconto real)!`
  } else if (diff < -500) {
    status = 'above'
    const formattedDiff = Math.abs(diff).toLocaleString('pt-BR')
    badgeText = `R$ ${formattedDiff} acima da FIPE (+${Math.abs(diffPercent)}%)`
    salesPitch = `Veículo selecionado e diferenciado, com histórico comprovado e procedência garantida.`
  }

  return {
    vehiclePrice,
    fipePrice,
    diff,
    diffPercent,
    status,
    badgeText,
    salesPitch,
  }
}
