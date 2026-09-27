import { localParts, localInstant, SCHEDULE_TIMEZONE } from '../lib/timezone.ts'

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
  timezone?: string
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
  const delay = options.minDelayMinutes ?? 10
  if (!Number.isFinite(ref.getTime()) || !Number.isFinite(delay) || delay < 0) throw new Error('Referência de agendamento inválida.')
  const earliest = ref.getTime() + delay * 60000
  const timezone = options.timezone || SCHEDULE_TIMEZONE
  const p = localParts(new Date(earliest), timezone)
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day))
  const existing = (options.existingTimestamps || []).filter(Number.isFinite).sort((a, b) => a - b)
  const spacing = 25 * 60000
  const freeTime = (start: number) => {
    let result = start
    for (const occupied of existing) if (Math.abs(occupied - result) < spacing) result = occupied + spacing
    return result
  }
  const result = (date: Date, confidence: OptimalScheduleResult['confidence'], window: string, jitterMinutes: number): OptimalScheduleResult =>
    ({ scheduledAt: date, isoString: date.toISOString(), confidence, window, jitterMinutes })
  const history = (options.historicalData || []).filter(h => h.successCount > 0 && Number.isInteger(h.dayOfWeek) && h.dayOfWeek >= 0 && h.dayOfWeek < 7 && Number.isInteger(h.hour) && h.hour >= 0 && h.hour < 24)
  if (history.length >= 5) {
    const best = [...history].sort((a, b) => b.successCount - a.successCount)[0]
    const targetDay = new Date(day)
    targetDay.setUTCDate(targetDay.getUTCDate() + (best.dayOfWeek - day.getUTCDay() + 7) % 7)
    const jitter = Math.floor(Math.random() * 21) - 10
    let candidate = localInstant(targetDay, best.hour * 60 + 15 + jitter, timezone)
    if (candidate.getTime() < earliest) {
      targetDay.setUTCDate(targetDay.getUTCDate() + 7)
      candidate = localInstant(targetDay, best.hour * 60 + 15 + jitter, timezone)
    }
    return result(new Date(freeTime(candidate.getTime())), 'historical', `Dia ${best.dayOfWeek} às ${best.hour}h`, jitter)
  }
  for (let offset = 0; offset < 7; offset++) {
    const targetDay = new Date(day)
    targetDay.setUTCDate(targetDay.getUTCDate() + offset)
    const weekend = [0, 6].includes(targetDay.getUTCDay())
    for (const win of weekend ? WEEKEND_PEAK_WINDOWS : WEEKDAY_PEAK_WINDOWS) {
      const jitter = Math.floor(Math.random() * 19) - 9
      const slot = localInstant(targetDay, win.startHour * 60 + win.startMin + jitter, timezone, Math.floor(Math.random() * 50))
      if (slot.getTime() >= earliest && freeTime(slot.getTime()) === slot.getTime()) {
        return result(slot, 'peak_heuristic', win.label, jitter)
      }
    }
  }
  const jitter = Math.floor(Math.random() * 15)
  return result(new Date(freeTime(earliest + (25 + jitter) * 60000)), 'peak_heuristic', 'Slot Adaptativo Livre', jitter)
}
