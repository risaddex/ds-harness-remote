import { z } from 'zod'
import type { RemoteCompactionOperations, RemoteCompactionOwner } from './remote-compaction-operations.js'
import { RpcError } from './safe-error.js'

const compactionSessionSchema = z.string().min(1).max(128)
const compactionSubmitSchema = z.object({
  sessionId: compactionSessionSchema,
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  budgetMs: z.number().int().min(60_000).max(7_200_000).optional(),
}).strict()
const compactionOperationSchema = z.object({
  sessionId: compactionSessionSchema,
  operationId: z.string().uuid(),
}).strict()

/** Per-connection view of the Host-wide async compaction registry. */
export interface RemoteCompactionRoute {
  operations: RemoteCompactionOperations
  owner: RemoteCompactionOwner
}

export function dispatchCompactionRpc(
  method: 'harness.remote.compaction.submit' | 'harness.remote.compaction.status' | 'harness.remote.compaction.cancel',
  params: unknown,
  route: RemoteCompactionRoute | undefined,
) {
  if (route === undefined) {
    throw new RpcError('FEATURE_NOT_SUPPORTED', 'This Host does not provide asynchronous Remote compaction.')
  }
  switch (method) {
    case 'harness.remote.compaction.submit': return route.operations.submit(compactionSubmitSchema.parse(params), route.owner)
    case 'harness.remote.compaction.status': return route.operations.status(compactionOperationSchema.parse(params), route.owner)
    case 'harness.remote.compaction.cancel': return route.operations.cancel(compactionOperationSchema.parse(params), route.owner)
  }
}
