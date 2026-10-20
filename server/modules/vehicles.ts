import { handleVehicleReadRoute, handleVehicleMutationRoute } from '../routes/vehicles.ts'
import { handlePhotoCurationRoute } from '../routes/photo-curation.ts'

// Keep route ownership in the vehicle module; the existing endpoints,
// permissions and relative dispatch order stay unchanged.
export function createVehicleModule(dependencies: {
  read: Parameters<typeof handleVehicleReadRoute>[4]
  photos: Parameters<typeof handlePhotoCurationRoute>[4]
  mutation: Parameters<typeof handleVehicleMutationRoute>[4]
}) {
  return {
    read(
      req: Parameters<typeof handleVehicleReadRoute>[0],
      res: Parameters<typeof handleVehicleReadRoute>[1],
      url: Parameters<typeof handleVehicleReadRoute>[2],
      auth: Parameters<typeof handleVehicleReadRoute>[3],
    ) {
      return handleVehicleReadRoute(req, res, url, auth, dependencies.read)
    },
    photos(
      req: Parameters<typeof handlePhotoCurationRoute>[0],
      res: Parameters<typeof handlePhotoCurationRoute>[1],
      url: Parameters<typeof handlePhotoCurationRoute>[2],
      auth: Parameters<typeof handlePhotoCurationRoute>[3],
    ) {
      return handlePhotoCurationRoute(req, res, url, auth, dependencies.photos)
    },
    mutation(
      req: Parameters<typeof handleVehicleMutationRoute>[0],
      res: Parameters<typeof handleVehicleMutationRoute>[1],
      url: Parameters<typeof handleVehicleMutationRoute>[2],
      auth: Parameters<typeof handleVehicleMutationRoute>[3],
    ) {
      return handleVehicleMutationRoute(req, res, url, auth, dependencies.mutation)
    },
  }
}
