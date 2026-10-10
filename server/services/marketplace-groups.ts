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

  /**
   * Merge/upsert only. A missing row must never imply deletion.
   * The caller must supply an explicit deletion list and use one transaction.
   */
  function replaceMarketplaceGroups(
    organizationId: number,
    values: unknown[],
    deletedGroupIds: number[] = [],
  ) {
    if (values.length > 2000) throw new Error('O cadastro permite até 2.000 grupos.')
    const existing = marketplaceGroups(organizationId)
    const byId = new Map(existing.map((group) => [group.id, group]))
    const incoming = values.map((value, index) => {
      const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      const parsed = typeof value === 'string'
        ? parseGroupTarget(value)
        : parseGroupTarget(record.url ? String(record.name || '') + ' | ' + String(record.url) : record.name)
      const suppliedId = Number(record.id) || 0
      if (suppliedId && !byId.has(suppliedId)) throw new Error('Grupo não encontrado nesta empresa.')
      const previous = suppliedId ? byId.get(suppliedId) : existing.find(
        (item) =>
          (parsed.groupKey && item.groupKey && parsed.groupKey === item.groupKey) ||
          (parsed.url && item.url && parsed.url.toLowerCase() === item.url.toLowerCase()) ||
          (!parsed.url && !item.url &&
            item.name.toLocaleLowerCase('pt-BR') === parsed.name.toLocaleLowerCase('pt-BR')),
      )
      return {
        ...parsed,
        id: previous?.id || 0,
        active: typeof value === 'string'
          ? previous?.active ?? 1
          : record.active === undefined ? previous?.active ?? 1 : (record.active === false || record.active === 0 ? 0 : 1),
        priority: index + 1,
        city: record.city === undefined ? previous?.city || '' : String(record.city || ''),
        state: record.state === undefined ? previous?.state || '' : String(record.state || ''),
        memberCount: record.memberCount === undefined
          ? previous?.memberCount || 0
          : Number(record.memberCount),
        privacy: record.privacy === undefined ? previous?.privacy || '' : String(record.privacy || ''),
      }
    })
    if (incoming.some((group) =>
      !group.name || !Number.isSafeInteger(group.memberCount) || group.memberCount < 0
    )) throw new Error('O CSV contém grupo sem nome ou quantidade de membros inválida.')
    const seenIds = new Set<number>()
    const seenNew = new Set<string>()
    for (const group of incoming) {
      if (group.id) {
        if (seenIds.has(group.id)) throw new Error('Grupo repetido no envio.')
        seenIds.add(group.id)
      } else {
        const key = group.groupKey || group.url.toLowerCase() || group.name.toLocaleLowerCase('pt-BR')
        if (seenNew.has(key)) throw new Error('Grupo repetido no envio.')
        seenNew.add(key)
      }
    }
    const deleted = new Set(deletedGroupIds)
    if ([...deleted].some((id) => !Number.isSafeInteger(id) || !byId.has(id)))
      throw new Error('A exclusão solicitada contém um grupo desconhecido.')
    if (incoming.some((group) => group.id && deleted.has(group.id)))
      throw new Error('O mesmo grupo não pode ser salvo e excluído.')
    for (const group of incoming) {
      if (group.id) {
        db.prepare(
          'UPDATE marketplace_groups SET name=?,url=?,group_key=?,active=?,priority=?,city=?,state=?,member_count=?,privacy=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?',
        ).run(
          group.name,group.url,group.groupKey,group.active,group.priority,
          group.city,group.state,group.memberCount,group.privacy,group.id,organizationId,
        )
      } else {
        db.prepare(
          'INSERT INTO marketplace_groups (organization_id,name,url,group_key,active,priority,city,state,member_count,privacy) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).run(
          organizationId,group.name,group.url,group.groupKey,group.active,group.priority,
          group.city,group.state,group.memberCount,group.privacy,
        )
      }
    }
    // Only administrator-confirmed explicit removals can delete rows.
    for (const id of deleted)
      db.prepare('DELETE FROM marketplace_groups WHERE id=? AND organization_id=?')
        .run(id, organizationId)
    const saved = marketplaceGroups(organizationId)
    const selected = incoming.map((item) => saved.find((group) =>
      item.id ? group.id === item.id : group.name === item.name && group.url === item.url,
    )).filter((item): item is MarketplaceGroup => Boolean(item))
    const selectedIds = new Set(selected.map((item) => item.id))
    const prioritized = [...selected, ...saved.filter((item) => !selectedIds.has(item.id))]
    for (const [index, group] of prioritized.entries())
      db.prepare('UPDATE marketplace_groups SET priority=? WHERE id=? AND organization_id=?')
        .run(index + 1, group.id, organizationId)
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
