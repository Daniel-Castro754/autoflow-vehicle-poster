export const SCHEDULE_TIMEZONE = process.env.SCHEDULE_TIMEZONE || 'America/Sao_Paulo'
const formatters = new Map<string, Intl.DateTimeFormat>()

export function localParts(date: Date, timezone = SCHEDULE_TIMEZONE) {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timezone, formatter)
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

// Calendar arithmetic happens in a UTC carrier; conversion uses the chosen IANA zone.
export function localInstant(
  day: Date,
  totalMinutes: number,
  timezone = SCHEDULE_TIMEZONE,
  seconds = 0,
) {
  const target = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    0,
    totalMinutes,
    seconds,
  )
  let instant = target
  for (let pass = 0; pass < 4; pass++) {
    const p = localParts(new Date(instant), timezone)
    const correction = target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    if (!correction) return new Date(instant)
    instant += correction
  }
  // A nonexistent local time during a DST jump must never become a past slot.
  return new Date(Math.max(target, instant))
}

export function businessDate(value: string | number, timezone = SCHEDULE_TIMEZONE) {
  const date =
    typeof value === 'number'
      ? new Date(value)
      : new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(' ', 'T') + 'Z')
  if (!Number.isFinite(date.getTime())) return null
  const p = localParts(date, timezone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}
