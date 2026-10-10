import type { DatabaseSync } from 'node:sqlite'

export type MarketplaceGroup = {
  id: number
  name: string
  url: string
  groupKey: string
  active: number
  priority: number
  successCount: number
  failureCount: number
  lastFoundAt?: string
  city?: string
  state?: string
  memberCount?: number
  privacy?: string
}

export function createMarketplaceGroupService(db: DatabaseSync) {
  function parseGroupTarget(value: unknown) {
    const raw = String(value || '').trim(),
      parts = raw
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean)
    const url =
      parts.find((item) => /^https?:\/\/(?:www\.|m\.)?facebook\.com\/groups\//i.test(item)) || ''
    const name = parts.find((item) => item !== url) || (!url ? raw : '')
    const key = (url.match(/facebook\.com\/groups\/([^/?#]+)/i)?.[1] || '').trim()
    return { name: name || key, url, groupKey: key }
  }

  function validateGroupTarget(value: unknown) {
    if (typeof value === 'string') {
      const parts = value
        .split('|')
        .map((item) => item.trim())
        .filter(Boolean)
      const possibleUrl = parts.find((item) => /^https?:\/\//i.test(item)) || ''
      return (
        Boolean(parseGroupTarget(value).name) &&
        (!possibleUrl ||
          /^https?:\/\/(?:www\.|m\.)?facebook\.com\/groups\/[^/?#]+/i.test(possibleUrl))
      )
    }
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    const name = String(record.name || '').trim(),
      url = String(record.url || '').trim()
    return (
      Boolean(name) &&
      (!url || /^https?:\/\/(?:www\.|m\.)?facebook\.com\/groups\/[^/?#]+/i.test(url))
    )
  }

  function groupTarget(group: Pick<MarketplaceGroup, 'name' | 'url'>) {
    return group.url ? `${group.name} | ${group.url}` : group.name
  }

  function marketplaceGroups(organizationId: number, activeOnly = false) {
    return db
      .prepare(
        `SELECT id,name,url,group_key groupKey,active,priority,success_count successCount,failure_count failureCount,last_found_at lastFoundAt,city,state,member_count memberCount,privacy
      FROM marketplace_groups WHERE organization_id=?${activeOnly ? ' AND active=1' : ''} ORDER BY priority,id`,
      )
      .all(organizationId) as MarketplaceGroup[]
  }

  function replaceMarketplaceGroups(organizationId: number, values: unknown[]) {
    const existing = marketplaceGroups(organizationId),
      byId = new Map(existing.map((group) => [group.id, group]))
    const incoming = values
      .slice(0, 2000)
      .map((value, index) => {
        if (typeof value === 'string')
          return { ...parseGroupTarget(value), id: 0, active: true, priority: index + 1, city: '', state: '', memberCount: 0, privacy: '' }
        const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
        const parsed = parseGroupTarget(
          record.url ? `${record.name || ''} | ${record.url}` : record.name,
        )
        return {
          ...parsed,
          id: Number(record.id) || 0,
          active: record.active !== false,
          priority: Number(record.priority) || index + 1,
          city: String(record.city || ''),
          state: String(record.state || ''),
          memberCount: Math.max(0, Number(record.memberCount || 0)),
          privacy: String(record.privacy || ''),
        }
      })
      .filter((group) => group.name)
    const incomingIds = new Set(incoming.map((group) => group.id).filter(Boolean))
    for (const group of existing) {
      if (!incomingIds.has(group.id))
        db.prepare('DELETE FROM marketplace_groups WHERE id=? AND organization_id=?').run(
          group.id,
          organizationId,
        )
    }
    for (const group of incoming) {
      if (group.id && byId.has(group.id)) {
        db.prepare(
          `UPDATE marketplace_groups SET name=?,url=?,group_key=?,active=?,priority=?,city=?,state=?,member_count=?,privacy=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
        ).run(
          group.name,
          group.url,
          group.groupKey,
          group.active ? 1 : 0,
          group.priority,
          group.city,
          group.state,
          group.memberCount || byId.get(group.id)?.memberCount || 0,
          group.privacy,
          group.id,
          organizationId,
        )
      } else {
        db.prepare(
          `INSERT INTO marketplace_groups (organization_id,name,url,group_key,active,priority,city,state,member_count,privacy) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          organizationId,
          group.name,
          group.url,
          group.groupKey,
          group.active ? 1 : 0,
          group.priority,
          group.city,
          group.state,
          group.memberCount,
          group.privacy,
        )
      }
    }
    const activeTargets = marketplaceGroups(organizationId, true).slice(0, 20).map(groupTarget)
    db.prepare(
      'UPDATE organization_settings SET target_groups=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=?',
    ).run(JSON.stringify(activeTargets), organizationId)
    return marketplaceGroups(organizationId)
  }

  return {
    parseGroupTarget,
    validateGroupTarget,
    groupTarget,
    marketplaceGroups,
    replaceMarketplaceGroups,
  }
}
