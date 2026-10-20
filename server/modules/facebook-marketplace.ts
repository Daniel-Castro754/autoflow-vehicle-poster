import { handleExtensionRoute, isExtensionRoute } from '../routes/extension.ts'
import { handleGroupsRoute } from '../routes/groups.ts'

// Facebook Marketplace is the *only* enabled publishing platform today.
// Do not expose Instagram routes or request Instagram permissions until a
// separately authenticated, supported connector actually exists.
export function createFacebookMarketplaceModule(dependencies: {
  extension: Parameters<typeof handleExtensionRoute>[4]
  groups: Parameters<typeof handleGroupsRoute>[4]
}) {
  return {
    acceptsExtension: isExtensionRoute,
    extension(
      req: Parameters<typeof handleExtensionRoute>[0],
      res: Parameters<typeof handleExtensionRoute>[1],
      url: Parameters<typeof handleExtensionRoute>[2],
      auth: Parameters<typeof handleExtensionRoute>[3],
    ) {
      return handleExtensionRoute(req, res, url, auth, dependencies.extension)
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
