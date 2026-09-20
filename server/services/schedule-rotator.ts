export function rotateSchedule(
  baseTime: Date,
  dayOfWeek: number,
  accountId: number
): Date {
  const schedulePatterns: Record<number, number[]> = {
    0: [9, 11, 14, 16, 19],      // Domingo
    1: [8, 10, 13, 15, 18, 20],  // Segunda
    2: [8, 11, 13, 16, 18, 21],  // Terça
    3: [9, 11, 14, 15, 18, 20],  // Quarta
    4: [8, 10, 13, 16, 18, 21],  // Quinta
    5: [9, 11, 14, 16, 17, 19],  // Sexta
    6: [9, 10, 14, 15, 18],      // Sábado
  }

  const hours = schedulePatterns[dayOfWeek] || schedulePatterns[1]
  const hour = hours[Math.abs(accountId) % hours.length]
  const jitter = Math.floor(Math.random() * 26) - 13 // ±13 min

  const result = new Date(baseTime)
  result.setHours(hour, 30 + jitter, Math.floor(Math.random() * 59), 0)

  if (result.getTime() < baseTime.getTime()) {
    result.setDate(result.getDate() + 1)
  }

  return result
}
