import type { VehicleInput } from './description-generator.ts'

export type ListingStyle = 'balanced'
export type ListingTextVariant = {
  id: number
  title: string
  description: string
}

const numberFormat = new Intl.NumberFormat('pt-BR')
const currencyFormat = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
})

function checkedText(value: unknown, label: string): string {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (text.length > 120 || /[{}|<>]/.test(text))
    throw new Error('Campo inválido para gerar anúncio: ' + label + '.')
  return text
}

// Group alternatives must be editorial wording only. Vehicle facts are resolved
// separately, so a value cannot inject another template expression.
export function renderListingTemplate(
  template: string,
  facts: Record<string, string>,
  variantIndex = 0,
): string {
  if (typeof template !== 'string' || template.length > 1600 || !template.trim())
    throw new Error('Modelo de texto inválido ou muito longo.')
  if (!Number.isInteger(variantIndex) || variantIndex < 0 || variantIndex > 100)
    throw new Error('Índice de variação inválido.')
  let groupIndex = 0
  const rendered = template.replace(/\{([^{}]+)\}/g, (_expression, raw: string) => {
    if (raw.includes('|')) {
      const options = raw.split('|')
      if (
        options.length < 2 ||
        options.length > 8 ||
        options.some((value) => !value.trim() || value.length > 120)
      )
        throw new Error('Grupo Spintax inválido.')
      const selection = options[(variantIndex + groupIndex) % options.length].trim()
      groupIndex++
      return selection
    }
    const key = raw.toLowerCase()
    if (!Object.hasOwn(facts, key))
      throw new Error('Variável não permitida no modelo: ' + key + '.')
    return facts[key]
  })
  if (/[{}]/.test(rendered))
    throw new Error('Modelo com chaves inválidas ou Spintax aninhado.')
  return rendered.replace(/[ \t]+\n/g, '\n').trim()
}

export function generateListingTextVariants(
  vehicle: VehicleInput,
  style: ListingStyle = 'balanced',
): ListingTextVariant[] {
  if (style !== 'balanced') throw new Error('Estilo de anúncio não suportado.')
  const year = Number(vehicle.year)
  const price = Number(vehicle.price)
  const km = Number(vehicle.km)
  if (
    !Number.isInteger(year) ||
    year < 1900 ||
    year > new Date().getFullYear() + 1 ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(km) ||
    km < 0 ||
    !Number.isSafeInteger(km)
  )
    throw new Error('Confira o ano, preço e quilometragem antes de gerar o texto.')
  const make = checkedText(vehicle.make, 'marca')
  const model = checkedText(vehicle.model, 'modelo')
  if (!make || !model)
    throw new Error('Marca e modelo precisam estar preenchidos.')

  const trim = checkedText(vehicle.trim, 'versão')
  const details = [
    'Ano: ' + year,
    'Quilometragem: ' + numberFormat.format(km) + ' km',
    'Preço: ' + currencyFormat.format(price),
  ]
  const optionalFields: Array<[string, unknown]> = [
    ['Câmbio', vehicle.transmission],
    ['Combustível', vehicle.fuelType],
    ['Carroceria', vehicle.bodyType],
    ['Cor externa', vehicle.exteriorColor],
    ['Cor interna', vehicle.interiorColor],
    ['Condição informada', vehicle.condition],
    ['Localização', vehicle.location],
  ]
  for (const [label, value] of optionalFields) {
    const text = checkedText(value, label)
    if (text) details.push(label + ': ' + text)
  }
  const facts: Record<string, string> = {
    ano: String(year),
    marca: make,
    modelo: model,
    versao: trim,
    km: numberFormat.format(km),
    preco: currencyFormat.format(price),
    titulo: [make, model, trim, String(year)].filter(Boolean).join(' '),
    detalhes: details.join('\n'),
  }
  const titleTemplates = [
    '{marca} {modelo} {versao} {ano}',
    '{marca} {modelo} {ano}',
    '{ano} {marca} {modelo} {versao}',
  ]
  const descriptionTemplates = [
    '{Conheça os dados deste veículo|Confira as informações do veículo|Informações para sua avaliação}:\n{titulo}\n\n{detalhes}\n\n{Fale conosco para mais informações.|Entre em contato para esclarecer dúvidas.|Envie uma mensagem para saber mais.}',
    '{Informações do anúncio|Dados do veículo|Confira este veículo}:\n{titulo}\n{detalhes}\n\n{Entre em contato para mais detalhes.|Envie uma mensagem para mais informações.|Fale conosco para tirar dúvidas.}',
    '{marca} {modelo} {ano}\n\n{detalhes}\n\n{Consulte mais informações pelo chat.|Tire suas dúvidas por mensagem.|Fale conosco para saber mais.}',
  ]
  return descriptionTemplates.map((template, index) => ({
    id: index + 1,
    title: renderListingTemplate(titleTemplates[index], facts, index)
      .replace(/\s+/g, ' ')
      .trim(),
    description: renderListingTemplate(template, facts, index),
  }))
}
