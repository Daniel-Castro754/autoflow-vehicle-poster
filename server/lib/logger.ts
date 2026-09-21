type Level = 'info' | 'warn' | 'error'

function emit(level: Level, scope: string, message: string, details?: Record<string, unknown>) {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${message}`
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  if (details) out(line, details)
  else out(line)
}

export const logger = {
  info: (scope: string, message: string, details?: Record<string, unknown>) => emit('info', scope, message, details),
  warn: (scope: string, message: string, details?: Record<string, unknown>) => emit('warn', scope, message, details),
  error: (scope: string, message: string, details?: Record<string, unknown>) => emit('error', scope, message, details),
}
