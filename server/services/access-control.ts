import type { DatabaseSync } from 'node:sqlite'

type AuthContext = { userId: number; organizationId: number }
type UserById = (id: number) => unknown

export function createAccessControl(db: DatabaseSync, userById: UserById) {
  function isAdmin(auth: AuthContext) {
    return (userById(auth.userId) as { role?: string } | undefined)?.role === 'admin'
  }

  function canWriteVehicle(vehicleId: number, auth: AuthContext) {
    return Boolean(
      isAdmin(auth)
        ? db
            .prepare('SELECT id FROM vehicles WHERE id=? AND organization_id=?')
            .get(vehicleId, auth.organizationId)
        : db
            .prepare(
              'SELECT id FROM vehicles WHERE id=? AND organization_id=? AND assigned_user_id=?',
            )
            .get(vehicleId, auth.organizationId, auth.userId),
    )
  }

  function refreshVehiclePublicationStatus(vehicleId: number, organizationId: number) {
    db.prepare(
      `UPDATE vehicles SET status=CASE
      WHEN EXISTS (SELECT 1 FROM publication_jobs WHERE vehicle_id=? AND organization_id=? AND status='completed') THEN 'Publicado'
      ELSE 'Pronto' END,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND organization_id=? AND status!='Vendido' AND sold_at IS NULL`,
    ).run(vehicleId, organizationId, vehicleId, organizationId)
  }

  function jobsIncludeSoldVehicle(ids: number[], organizationId: number) {
    return (
      ids.length > 0 &&
      Boolean(
        db
          .prepare(
            `SELECT j.id FROM publication_jobs j JOIN vehicles v ON v.id=j.vehicle_id
      WHERE j.organization_id=? AND j.id IN (${ids.map(() => '?').join(',')}) AND (v.status='Vendido' OR v.sold_at IS NOT NULL) LIMIT 1`,
          )
          .get(organizationId, ...ids),
      )
    )
  }

  function canWriteImage(imageId: number, auth: AuthContext) {
    return Boolean(
      isAdmin(auth)
        ? db
            .prepare(
              'SELECT i.id FROM vehicle_images i JOIN vehicles v ON v.id=i.vehicle_id WHERE i.id=? AND i.organization_id=? AND v.organization_id=?',
            )
            .get(imageId, auth.organizationId, auth.organizationId)
        : db
            .prepare(
              'SELECT i.id FROM vehicle_images i JOIN vehicles v ON v.id=i.vehicle_id WHERE i.id=? AND i.organization_id=? AND v.organization_id=? AND v.assigned_user_id=?',
            )
            .get(imageId, auth.organizationId, auth.organizationId, auth.userId),
    )
  }

  function canManageJobs(ids: number[], auth: AuthContext) {
    if (!ids.length) return false
    const placeholders = ids.map(() => '?').join(',')
    const row = isAdmin(auth)
      ? db
          .prepare(
            `SELECT COUNT(*) total FROM publication_jobs WHERE organization_id=? AND id IN (${placeholders})`,
          )
          .get(auth.organizationId, ...ids)
      : db
          .prepare(
            `SELECT COUNT(*) total FROM publication_jobs j JOIN social_accounts a ON a.id=j.social_account_id
        WHERE j.organization_id=? AND a.organization_id=? AND a.user_id=? AND j.id IN (${placeholders})`,
          )
          .get(auth.organizationId, auth.organizationId, auth.userId, ...ids)
    return Number((row as { total?: number } | undefined)?.total) === ids.length
  }

  function allowedExtensionAccount(accountId: number, auth: AuthContext) {
    const current = userById(auth.userId) as { role?: string } | undefined
    return current?.role === 'admin'
      ? db
          .prepare(
            `SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.user_id userId,
            a.automation_paused automationPaused,a.automation_pause_reason automationPauseReason,a.automation_paused_at automationPausedAt,u.name owner
          FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.organization_id=?`,
          )
          .get(accountId, auth.organizationId)
      : db
          .prepare(
            `SELECT a.id,a.label,a.browser_profile browserProfile,a.status,a.user_id userId,
            a.automation_paused automationPaused,a.automation_pause_reason automationPauseReason,a.automation_paused_at automationPausedAt,u.name owner
          FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.organization_id=? AND a.user_id=?`,
          )
          .get(accountId, auth.organizationId, auth.userId)
  }

  return {
    isAdmin,
    canWriteVehicle,
    refreshVehiclePublicationStatus,
    jobsIncludeSoldVehicle,
    canWriteImage,
    canManageJobs,
    allowedExtensionAccount,
  }
}
