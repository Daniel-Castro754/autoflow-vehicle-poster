import { handleExtensionRoute, isExtensionRoute } from '../routes/extension.ts'
import { handlePublicationReadRoute, isPublicationReadRoute } from '../routes/publication-reads.ts'
import {
  handlePublicationManagementRoute,
  isPublicationManagementRoute,
} from '../routes/publication-management.ts'
import { handlePublicationSchedulingRoute } from '../routes/publication-scheduling.ts'
import { handleGroupsRoute } from '../routes/groups.ts'

// Facebook Marketplace is the *only* enabled publishing platform today.
// Do not expose Instagram routes or request Instagram permissions until a
// separately authenticated, supported connector actually exists.
export function createFacebookMarketplaceModule(dependencies: {
  extension: Parameters<typeof handleExtensionRoute>[4]
  publicationRead: Parameters<typeof handlePublicationReadRoute>[4]
  management: Parameters<typeof handlePublicationManagementRoute>[4]
  scheduling: Parameters<typeof handlePublicationSchedulingRoute>[4]
  groups: Parameters<typeof handleGroupsRoute>[4]
}) {
  return {
    acceptsExtension: isExtensionRoute,
    acceptsPublicationRead: isPublicationReadRoute,
    acceptsManagement: isPublicationManagementRoute,
    extension(
      req: Parameters<typeof handleExtensionRoute>[0],
      res: Parameters<typeof handleExtensionRoute>[1],
      url: Parameters<typeof handleExtensionRoute>[2],
      auth: Parameters<typeof handleExtensionRoute>[3],
    ) {
      return handleExtensionRoute(req, res, url, auth, dependencies.extension)
    },
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
    groups(
      req: Parameters<typeof handleGroupsRoute>[0],
      res: Parameters<typeof handleGroupsRoute>[1],
      url: Parameters<typeof handleGroupsRoute>[2],
      auth: Parameters<typeof handleGroupsRoute>[3],
    ) {
      return handleGroupsRoute(req, res, url, auth, dependencies.groups)
    },
  }
}
