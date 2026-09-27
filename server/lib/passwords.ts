import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const PREFIX = 'scrypt-v2'
const CURRENT = { N: 2 ** 16, r: 8, p: 2, maxmem: 128 * 1024 * 1024 }
const LEGACY = { N: 2 ** 14, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }
function derive(password: string, salt: string, modern: boolean) {
  return new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64,
    modern ? CURRENT : LEGACY, (error, key) => error ? reject(error) : resolve(key)))
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  return `${PREFIX}:${salt}:${(await derive(password, salt, true)).toString('hex')}`
}
export function passwordNeedsUpgrade(stored: string) {
  return !stored.startsWith(`${PREFIX}:`)
}
export async function verifyPassword(password: string, stored: string) {
  const parts = stored.split(':')
  const modern = parts.length === 3 && parts[0] === PREFIX
  if (!modern && parts.length !== 2) return false
  const [salt, expected] = modern ? parts.slice(1) : parts
  if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(expected || '')) return false
  try { return timingSafeEqual(await derive(password, salt, modern), Buffer.from(expected, 'hex')) }
  catch { return false }
}
