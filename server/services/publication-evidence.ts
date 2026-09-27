export function readPublicationReport(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function publicationMayExist(job: { publishAttemptAt?: unknown; fillReport?: unknown }) {
  const report = readPublicationReport(job.fillReport)
  return Boolean(job.publishAttemptAt || report.published === true || report.publishAttempted === true && report.publishNotClicked !== true)
}

export function ambiguousPublicationReport(value: unknown) {
  const report = readPublicationReport(value)
  return {
    filledCount: 0, totalCount: 0, imageCount: 0, fields: [], ...report,
    missing: Array.isArray(report.missing) ? report.missing : [],
    selectedGroups: Array.isArray(report.selectedGroups) ? report.selectedGroups : [],
    missingGroups: Array.isArray(report.missingGroups) ? report.missingGroups : [],
    flowIssues: Array.isArray(report.flowIssues) ? report.flowIssues : [],
    publishAttempted: true, published: false, staleRecovery: true, publishPhase: 'result_unknown',
    reason: 'lease_lost_after_publish_attempt',
  }
}
