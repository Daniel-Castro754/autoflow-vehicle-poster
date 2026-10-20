// Backward-compatible import path for existing services and tests.
// New integrations should import the shared account module directly.
export { findBestAccountForVehicle } from '../modules/accounts.ts'
export type { AvailableAccount } from '../modules/accounts.ts'
