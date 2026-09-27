import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

const context = new AsyncLocalStorage<{ requestId: string }>()

export function requestIdFor(value: string | string[] | undefined): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
    ? value
    : randomUUID()
}

export function withRequestContext<T>(requestId: string, operation: () => T): T {
  return context.run({ requestId }, operation)
}

export function currentRequestId(): string | undefined {
  return context.getStore()?.requestId
}
