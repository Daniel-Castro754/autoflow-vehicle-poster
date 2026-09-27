export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs?: number
  jitter?: boolean
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
  shouldRetry?: (error: Error) => boolean
}

export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs = 60000,
  jitter = true
): number {
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0 || !Number.isFinite(maxDelayMs) || maxDelayMs < 0 || Number.isNaN(attempt)) throw new RangeError('Parâmetros de backoff inválidos.')
  const exponential = baseDelayMs === 0 ? 0 : baseDelayMs * Math.pow(2, Math.max(0, attempt - 1))
  const capped = Math.min(exponential, maxDelayMs)
  if (!jitter) return Math.min(Math.round(capped), Math.floor(maxDelayMs))
  const jitterAmount = Math.random() * Math.min(1000, capped * 0.25)
  return Math.min(Math.round(capped + jitterAmount), Math.floor(maxDelayMs))
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs = 60000,
    jitter = true,
    onRetry,
    shouldRetry = () => false,
  } = options

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts deve ser um inteiro positivo.')
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (caught) {
      lastError = caught instanceof Error ? caught : new Error(String(caught))

      if (attempt >= maxAttempts || !shouldRetry(lastError)) {
        throw lastError
      }

      const delayMs = calculateBackoff(attempt, baseDelayMs, maxDelayMs, jitter)
      onRetry?.(attempt, lastError, delayMs)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  throw lastError || new Error('Retry finalizado sem sucesso.')
}
