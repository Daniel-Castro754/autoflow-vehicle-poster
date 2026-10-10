export interface GroupRecord {
  id: number
  name: string
  url: string
  groupKey: string
  active: number | boolean
  priority: number
  successCount: number
  failureCount: number
  lastFoundAt?: string
  city?: string
  state?: string
  memberCount?: number
}

export interface CuratedGroupResult {
  group: GroupRecord
  score: number
  recommendedActive: boolean
  reliabilityRate: number
  reason: string
}

export function evaluateGroupScore(group: GroupRecord, locationQuery = ''): CuratedGroupResult {
  const totalAttempts = (group.successCount || 0) + (group.failureCount || 0)
  const successRate = totalAttempts > 0 ? group.successCount / totalAttempts : 0.8 // default otimista se novo

  // Pontuação por taxa de sucesso (0 a 60 pontos)
  let score = successRate * 60

  // Bônus por volume comprovado de sucessos (até 15 pontos)
  score += Math.min(15, (group.successCount || 0) * 3)

  // Penalidade por falhas frequentes
  if (group.failureCount > 3 && successRate < 0.4) {
    score -= 20
  }

  // Recência (últimos 7 dias ganha bônus de 10 pontos)
  if (group.lastFoundAt) {
    const elapsedDays =
      (Date.now() - new Date(group.lastFoundAt.replace(' ', 'T') + 'Z').getTime()) / (1000 * 86400)
    if (elapsedDays <= 7) score += 10
    else if (elapsedDays <= 30) score += 5
  }

  // Membros: escala logarítmica reduz dominância de grupos enormes.
  score += Math.min(35, Math.log10(1 + Math.max(0, group.memberCount || 0)) * 7)

  // Proximidade: apenas correspondência de cidade/UF conhecida; não inventar distâncias.
  if (locationQuery) {
    const normalize = (value: string) =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR')
    const ref = normalize(locationQuery)
    const city = normalize(group.city || '').trim()
    const state = normalize(group.state || '').trim()
    if (city && ref.includes(city)) score += 45
    else if (state && ref.includes(state)) score += 12
  }
  // Relevância geográfica
  if (locationQuery) {
    const locLower = locationQuery.toLowerCase()
    const nameLower = group.name.toLowerCase()
    const parts = locLower
      .split(/[, -]+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 3)
    const match = parts.some((p) => nameLower.includes(p))
    if (match) score += 15
  }

  score = Math.max(0, Math.round(score))
  const reliabilityRate = Math.round(successRate * 100)

  let reason = 'Grupo equilibrado'
  if (totalAttempts === 0) reason = 'Grupo recém-adicionado'
  else if (reliabilityRate >= 90) reason = 'Alta taxa de aprovação no Facebook'
  else if (reliabilityRate < 40) reason = 'Apresentou falhas repetidas'

  return {
    group,
    score,
    recommendedActive: score >= 40,
    reliabilityRate,
    reason,
  }
}

export function curateMarketplaceGroups(
  groups: GroupRecord[],
  locationQuery = '',
  maxActive = 10,
): CuratedGroupResult[] {
  const evaluated = groups.map((g) => evaluateGroupScore(g, locationQuery))
  evaluated.sort((a, b) => b.score - a.score)

  // Marca os top `maxActive` como recomendados
  return evaluated.map((item, index) => ({
    ...item,
    recommendedActive: index < maxActive && item.score >= 30,
  }))
}
