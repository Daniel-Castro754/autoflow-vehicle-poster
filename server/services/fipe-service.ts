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

const BASE_URL = 'https://parallelum.com.br/fipe/api/v1/carros/marcas'
const CACHE_TTL_MS = 30 * 86400_000
const fipeMemoryCache = new Map<string, FipeResult>()
let brandCache: { entries: Array<{codigo: string; nome: string}>; fetchedAt: number } | undefined

function normalize(value: string) {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
function brandKey(value: string) {
  const key = normalize(value)
  return ({ gm:'chevrolet', 'gm chevrolet':'chevrolet', 'chevrolet gm':'chevrolet', vw:'volkswagen',
    'vw volkswagen':'volkswagen', mercedes:'mercedes benz', caoa:'chery', 'caoa chery':'chery' } as Record<string,string>)[key] || key
}
function fresh(timestamp: number) {
  const now = Date.now()
  return now >= timestamp && now - timestamp < CACHE_TTL_MS && new Date(now).toISOString().slice(0,7) === new Date(timestamp).toISOString().slice(0,7)
}
export function clearFipeCache() {
  fipeMemoryCache.clear()
  brandCache = undefined
}

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

  const cacheKey = `${brandKey(make)}_${normalize(model)}_${year}`
  const cached = fipeMemoryCache.get(cacheKey)
  if (cached && fresh(Date.parse(cached.fetchedAt))) return { ...cached }
  fipeMemoryCache.delete(cacheKey)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    if (!brandCache || !fresh(brandCache.fetchedAt)) {
      const response = await fetch(BASE_URL, { signal: controller.signal })
      if (!response.ok) return null
      const entries = await response.json() as Array<{codigo: string; nome: string}>
      if (!Array.isArray(entries)) return null
      brandCache = { entries, fetchedAt: Date.now() }
    }
    const brand = brandCache.entries.find(b => brandKey(b.nome) === brandKey(make))
    if (!brand || !/^\d+$/.test(brand.codigo)) return null
    const brandCode = brand.codigo

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
    const cleanModel = normalize(model)
    const modelTerms = cleanModel.split(/\s+/).filter(Boolean)
    if (!modelTerms.length) return null

    // Primeiro tenta correspondência onde todos os termos estejam presentes
    const matchedModel = modelsData.modelos.find((m) => {
      const name = normalize(m.nome)
      return modelTerms.every((term) => name.includes(term))
    })

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
      years.find((y) => y.codigo.split('-')[0] === targetYearStr)

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

    if (!priceData.Valor || brandKey(priceData.Marca || '') !== brandKey(make) || Number(priceData.AnoModelo) !== year) return null
    if (!modelTerms.every(term => normalize(priceData.Modelo || '').includes(term))) return null

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
      fetchedAt: new Date(Date.now()).toISOString(),
    }

    for (const [key, value] of fipeMemoryCache) if (!fresh(Date.parse(value.fetchedAt))) fipeMemoryCache.delete(key)
    if (fipeMemoryCache.size >= 500) fipeMemoryCache.delete(fipeMemoryCache.keys().next().value!)
    fipeMemoryCache.set(cacheKey, result)
    return { ...result }
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
