import { currentRequestId } from './request-context.ts'

type Level = 'info' | 'warn' | 'error'
const LEVELS = { info: 0, warn: 1, error: 2 }
const SENSITIVE = /password|token|authorization|cookie|secret|api_?key/i
function redact(text: string) {
  return text
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(\/bot)[^/\s]+(?=\/)/g, '$1[REDACTED]')
    .replace(/((?:password|token|secret|api_?key|key)=)[^&\s"']+/gi, '$1[REDACTED]')
}
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[deep]'
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'bigint') return String(value)
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error)
    return {
      name: value.name,
      message: redact(value.message),
      stack: redact(value.stack || ''),
      cause: sanitize(value.cause, depth + 1),
    }
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitize(v, depth + 1))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE.test(key) ? '[REDACTED]' : sanitize(item, depth + 1),
    ]),
  )
}
function emit(level: Level, scope: string, message: string, details?: Record<string, unknown>) {
  const minLevel = LEVELS[process.env.LOG_LEVEL as Level] ?? LEVELS.info
  if (LEVELS[level] < minLevel) return
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    ...(currentRequestId() ? { requestId: currentRequestId() } : {}),
    message: redact(message),
    ...(details ? { details: sanitize(details) } : {}),
  })
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  out(line)
}
export const logger = {
  info: (scope: string, message: string, details?: Record<string, unknown>) =>
    emit('info', scope, message, details),
  warn: (scope: string, message: string, details?: Record<string, unknown>) =>
    emit('warn', scope, message, details),
  error: (scope: string, message: string, details?: Record<string, unknown>) =>
    emit('error', scope, message, details),
}
