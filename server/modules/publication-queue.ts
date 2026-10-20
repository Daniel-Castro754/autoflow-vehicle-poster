import type { DatabaseSync } from 'node:sqlite'
import { createAutonomousScheduler } from '../services/autonomous-scheduler.ts'
import { handlePublicationReadRoute, isPublicationReadRoute } from '../routes/publication-reads.ts'
import {
  handlePublicationManagementRoute,
  isPublicationManagementRoute,
} from '../routes/publication-management.ts'
import { handlePublicationSchedulingRoute } from '../routes/publication-scheduling.ts'

// A shared queue boundary independent of the browser/platform adapter.
// Existing route handlers own validation, authorization, leasing and writes.
// This module only assembles them without changing their relative dispatch order.
export function createPublicationQueueModule(dependencies: {
  db: DatabaseSync
  publicationRead: Parameters<typeof handlePublicationReadRoute>[4]
  management: Parameters<typeof handlePublicationManagementRoute>[4]
  scheduling: Parameters<typeof handlePublicationSchedulingRoute>[4]
}) {
  return {
    scheduler: createAutonomousScheduler(dependencies.db),
    acceptsPublicationRead: isPublicationReadRoute,
    acceptsManagement: isPublicationManagementRoute,
    publicationRead(
      req: Parameters<typeof handlePublicationReadRoute>[0],
      res: Parameters<typeof handlePublicationReadRoute>[1],
      url: Parameters<typeof handlePublicationReadRoute>[2],
      auth: Parameters<typeof handlePublicationReadRoute>[3],
    ) {
      return handlePublicationReadRoute(req, res, url, auth, dependencies.publicationRead)
    },
    management(
      req: Parameters<typeof handlePublicationManagementRoute>[0],
      res: Parameters<typeof handlePublicationManagementRoute>[1],
      url: Parameters<typeof handlePublicationManagementRoute>[2],
      auth: Parameters<typeof handlePublicationManagementRoute>[3],
    ) {
      return handlePublicationManagementRoute(req, res, url, auth, dependencies.management)
    },
    scheduling(
      req: Parameters<typeof handlePublicationSchedulingRoute>[0],
      res: Parameters<typeof handlePublicationSchedulingRoute>[1],
      url: Parameters<typeof handlePublicationSchedulingRoute>[2],
      auth: Parameters<typeof handlePublicationSchedulingRoute>[3],
    ) {
      return handlePublicationSchedulingRoute(req, res, url, auth, dependencies.scheduling)
    },
  }
}
