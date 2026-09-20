export interface HistoricalEngagement {
  dayOfWeek: number
  hour: number
  successCount: number
}

export interface ScheduleOptions {
  referenceDate?: Date
  existingTimestamps?: number[]
  historicalData?: HistoricalEngagement[]
  minDelayMinutes?: number
  accountId?: number
}

export interface OptimalScheduleResult {
  scheduledAt: Date
  isoString: string
  confidence: 'historical' | 'peak_heuristic'
  window: string
  jitterMinutes: number
}

// Janelas ideais de compra e venda de veículos no Brasil (Horário Comercial / Pico)
export const WEEKDAY_PEAK_WINDOWS = [
  { startHour: 8, startMin: 45, endHour: 9, endMin: 30, label: 'Manhã Comercial' },
  { startHour: 12, startMin: 15, endHour: 13, endMin: 30, label: 'Almoço' },
  { startHour: 17, startMin: 45, endHour: 19, endMin: 15, label: 'Fim de Tarde' },
  { startHour: 20, startMin: 30, endHour: 21, endMin: 45, label: 'Noite' },
]

export const WEEKEND_PEAK_WINDOWS = [
  { startHour: 9, startMin: 45, endHour: 11, endMin: 30, label: 'Fim de Semana Manhã' },
  { startHour: 14, startMin: 30, endHour: 16, endMin: 30, label: 'Fim de Semana Tarde' },
  { startHour: 18, startMin: 30, endHour: 20, endMin: 0, label: 'Fim de Semana Noite' },
]

export function calculateOptimalSchedule(options: ScheduleOptions = {}): OptimalScheduleResult {
  const ref = options.referenceDate ? new Date(options.referenceDate) : new Date()
  const minDelayMinutes = options.minDelayMinutes || 10
  const earliestAllowed = new Date(ref.getTime() + minDelayMinutes * 60000)
  const existing = options.existingTimestamps || []

  // Se houver dados históricos expressivos (> 5 registros com sucesso)
  const validHistory = (options.historicalData || []).filter(h => h.successCount > 0)
  if (validHistory.length >= 5) {
    const sorted = [...validHistory].sort((a, b) => b.successCount - a.successCount)
    const best = sorted[0]

    // Tentar agendar para o melhor dia/hora
    const candidate = new Date(earliestAllowed)
    const currentDay = candidate.getDay()
    let daysUntil = (best.dayOfWeek - currentDay + 7) % 7
    if (daysUntil === 0 && candidate.getHours() >= best.hour) {
      daysUntil = 7
    }

    candidate.setDate(candidate.getDate() + daysUntil)
    const jitter = Math.floor(Math.random() * 21) - 10 // -10 a +10 min
    candidate.setHours(best.hour, Math.max(0, Math.min(59, 15 + jitter)), 0, 0)

    // Verificar se não colide com agendamentos existentes (distância mínima de 25 min)
    let finalTime = candidate.getTime()
    while (existing.some(t => Math.abs(t - finalTime) < 25 * 60000)) {
      finalTime += 35 * 60000
    }

    const scheduledAt = new Date(finalTime)
    return {
      scheduledAt,
      isoString: scheduledAt.toISOString(),
      confidence: 'historical',
      window: `Dia ${best.dayOfWeek} às ${best.hour}h`,
      jitterMinutes: jitter,
    }
  }

  // Heurística de Janelas de Pico com Jitter Anti-Detecção
  // Procuramos o próximo slot de pico disponível a partir de `earliestAllowed`
  const candidateDay = new Date(earliestAllowed)

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const checkDate = new Date(candidateDay)
    checkDate.setDate(checkDate.getDate() + dayOffset)
    const isWeekend = checkDate.getDay() === 0 || checkDate.getDay() === 6
    const windows = isWeekend ? WEEKEND_PEAK_WINDOWS : WEEKDAY_PEAK_WINDOWS

    for (const win of windows) {
      // Cria a data para esta janela
      const slotTime = new Date(checkDate)
      const jitter = Math.floor(Math.random() * 19) - 9 // -9 a +9 minutos de variação
      const minutes = Math.max(0, Math.min(59, win.startMin + jitter))
      slotTime.setHours(win.startHour, minutes, Math.floor(Math.random() * 50), 0)

      if (slotTime.getTime() > earliestAllowed.getTime()) {
        // Checa colisão com agendamentos existentes
        const targetTimestamp = slotTime.getTime()
        const hasCollision = existing.some(t => Math.abs(t - targetTimestamp) < 25 * 60000)

        if (!hasCollision) {
          const finalDate = new Date(targetTimestamp)
          return {
            scheduledAt: finalDate,
            isoString: finalDate.toISOString(),
            confidence: 'peak_heuristic',
            window: win.label,
            jitterMinutes: jitter,
          }
        }
      }
    }
  }

  // Fallback: 35 minutos adiante com jitter
  const fallbackJitter = Math.floor(Math.random() * 15)
  const fallbackDate = new Date(earliestAllowed.getTime() + (25 + fallbackJitter) * 60000)
  return {
    scheduledAt: fallbackDate,
    isoString: fallbackDate.toISOString(),
    confidence: 'peak_heuristic',
    window: 'Slot Adaptativo Livre',
    jitterMinutes: fallbackJitter,
  }
}
