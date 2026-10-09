import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { operationalHealth, prometheusMetrics } from '../services/operational-health.ts'
import { organizationScheduleHistory } from '../services/schedule-history.ts'

export function handleOperationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: { organizationId: number },
  db: DatabaseSync,
  send: (res: ServerResponse, status: number, data: unknown) => void,
): boolean {
  if (req.method === 'GET' && url.pathname === '/api/operations/scheduling-insights') {
    const history = organizationScheduleHistory(db, auth.organizationId)
    const totalSamples = history.reduce((sum, hour) => sum + (hour.attemptCount || 0), 0)
    const successes = history.reduce((sum, hour) => sum + hour.successCount, 0)
    const ranked = history
      .filter((hour) => (hour.attemptCount || 0) >= 4)
      .map((hour) => ({
        dayOfWeek: hour.dayOfWeek,
        hour: hour.hour,
        samples: hour.attemptCount || 0,
        completions: hour.successCount,
        observedRate: Math.round((100 * hour.successCount) / (hour.attemptCount || 1)),
        score: (hour.successCount + 2) / ((hour.attemptCount || 0) + 4),
      }))
      .sort((a, b) => b.score - a.score || b.samples - a.samples)
      .slice(0, 5)
      .map(({ score: _score, ...hour }) => hour)
    res.setHeader('Cache-Control', 'no-store')
    send(res, 200, {
      eligible: totalSamples >= 20 && ranked.length > 0,
      totalSamples,
      totalCompletions: successes,
      completionRate: totalSamples ? Math.round((100 * successes) / totalSamples) : null,
      topSlots: totalSamples >= 20 ? ranked : [],
      metric: 'Conclusão operacional por tentativa terminal, não visualizações, leads ou vendas.',
      source: 'Registros locais dos últimos 180 dias; exclui publicações de resultado incerto.',
    })
    return true
  }
  if (req.method !== 'GET' || !['/api/health/detailed', '/api/metrics'].includes(url.pathname))
    return false
  const report = operationalHealth(db, auth.organizationId)
  res.setHeader('Cache-Control', 'no-store')
  if (url.pathname === '/api/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
    res.end(prometheusMetrics(report))
  } else send(res, 200, { ok: true, ...report })
  return true
}
