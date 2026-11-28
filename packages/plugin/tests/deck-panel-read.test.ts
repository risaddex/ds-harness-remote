import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import { createRpcRequest, type RemoteMessage, type RpcRequestPayload } from '@dsh-remote/protocol'
import { describe, expect, it, vi } from 'vitest'
import { DeckPanelReadHost, type DeckPanelReadHostOptions, type DeckPanelReadServiceLike, type DeckPanelReadSessionAuthority } from '../src/deck-panel-read.js'
import type { SafeLogger } from '../src/logging.js'
import { RpcRouter } from '../src/rpc-router.js'

const CAPABILITY = 'deck.panel.read.v1'
const BASE_CAPABILITIES = ['transport.relay', 'harness.remote.v1', 'remote.history.compact.v1']

const treeReply = (sessionId = 'sess-1') => ({ ok: true, sessionId, containers: [{ key: '70', kind: 'spec', title: 'Spec', tickets: [] }], truncated: false })
const ticketReply = (sessionId = 'sess-1') => ({ ok: true, sessionId, ticket: { key: '83', title: 'Ticket', state: 'open', body: 'text' } })

/** A deck service whose every member is observable, plus one member the relay must never touch. */
function deckService(overrides: Partial<DeckPanelReadServiceLike> = {}) {
  const call = vi.fn(async (operation: string, params: Record<string, unknown>) => operation === 'tree' ? treeReply(String(params.sessionId)) : ticketReply(String(params.sessionId)))
  const available = vi.fn(async () => ({ available: true }))
  const anythingElse = vi.fn()
  const service = { feature: CAPABILITY, operations: ['tree', 'ticket'], available, call, anythingElse, ...overrides } as unknown as DeckPanelReadServiceLike
  return { service, call, available, anythingElse }
}

/** The default authority knows every session; scenarios that care about the gate pass their own. */
const knowsEverySession: DeckPanelReadSessionAuthority = async () => '/workspace'

function routerFor(resolve: () => DeckPanelReadServiceLike | undefined, options?: DeckPanelReadHostOptions, authority: DeckPanelReadSessionAuthority = knowsEverySession) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SafeLogger
  const host = new DeckPanelReadHost(resolve, authority, logger, options)
  const router = new RpcRouter(
    undefined, logger, undefined, undefined, () => ['transport.relay', 'harness.remote.v1'], undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, host,
  )
  return { router, logger }
}

async function describeCapabilities(router: RpcRouter): Promise<string[]> {
  const response = await router.handle(createRpcRequest('harness.transport.describe', {}))
  expect(response.type).toBe('rpc.response')
  return (response.payload as { result: { capabilities: string[] } }).result.capabilities
}

async function read(router: RpcRouter, params: unknown): Promise<RemoteMessage> {
  return router.handle(createRpcRequest('deck.panel.read' as RpcRequestPayload['method'], params as never))
}

const result = (response: RemoteMessage): unknown => {
  expect(response.type).toBe('rpc.response')
  return (response.payload as { result: unknown }).result
}

const failureKind = (response: RemoteMessage): string => (result(response) as { error: { kind: string } }).error.kind

describe('deck panel read over the Remote relay', () => {
  it('forwards the tree read and one ticket read and returns the deck replies untouched', async () => {
    const { service, call } = deckService()
    const { router } = routerFor(() => service)

    const tree = await read(router, { operation: 'tree', sessionId: 'sess-1' })
    const ticket = await read(router, { operation: 'ticket', sessionId: 'sess-1', key: '83' })
    const numeric = await read(router, { operation: 'ticket', sessionId: 'sess-1', key: 83 })

    expect(result(tree)).toEqual(treeReply())
    expect(result(ticket)).toEqual(ticketReply())
    expect(result(numeric)).toEqual(ticketReply())
    expect(call.mock.calls).toEqual([
      ['tree', { sessionId: 'sess-1' }],
      ['ticket', { sessionId: 'sess-1', key: '83' }],
      ['ticket', { sessionId: 'sess-1', key: 83 }],
    ])
  })

  it('announces the feature only while the deck is present and answers { available: true }', async () => {
    const unavailable = [
      { name: 'service missing', resolve: () => undefined, options: undefined },
      { name: 'available false with a reason', resolve: () => deckService({ available: vi.fn(async () => ({ available: false, reason: 'load-failed' })) }).service, options: undefined },
      { name: 'probe throws', resolve: () => deckService({ available: vi.fn(() => { throw new Error('/Users/me/secret') }) }).service, options: undefined },
      { name: 'probe rejects', resolve: () => deckService({ available: vi.fn(async () => { throw new Error('boom') }) }).service, options: undefined },
      { name: 'probe never answers', resolve: () => deckService({ available: vi.fn(() => new Promise(() => undefined)) }).service, options: { probeTimeoutMs: 20 } },
      { name: 'answer is not exactly true', resolve: () => deckService({ available: vi.fn(async () => ({ available: 'yes' })) }).service, options: undefined },
      { name: 'answer is not an object', resolve: () => deckService({ available: vi.fn(async () => true) }).service, options: undefined },
      { name: 'service names another feature', resolve: () => deckService({ feature: 'deck.panel.read.v2' } as Partial<DeckPanelReadServiceLike>).service, options: undefined },
      { name: 'service without call', resolve: () => ({ feature: CAPABILITY, available: async () => ({ available: true }) }) as unknown as DeckPanelReadServiceLike, options: undefined },
      { name: 'lookup throws', resolve: () => { throw new Error('no context') }, options: undefined },
    ]
    await runScenarios(unavailable.map(row => ({ name: row.name, run: async () => {
      const { router } = routerFor(row.resolve, row.options)
      expect(await describeCapabilities(router)).toEqual(BASE_CAPABILITIES)
    } })))

    const { router } = routerFor(() => deckService().service)
    expect(await describeCapabilities(router)).toEqual([...BASE_CAPABILITIES, CAPABILITY])
  })

  it('asks on demand: a service that appears after start-up is announced and one that goes away is not', async () => {
    let current: DeckPanelReadServiceLike | undefined
    const first = deckService()
    const { router } = routerFor(() => current)

    expect(await describeCapabilities(router)).toEqual(BASE_CAPABILITIES)
    expect(result(await read(router, { operation: 'tree', sessionId: 'sess-1' }))).toMatchObject({ ok: false, error: { kind: 'unavailable' } })

    current = first.service
    expect(await describeCapabilities(router)).toContain(CAPABILITY)
    expect(await describeCapabilities(router)).toContain(CAPABILITY)
    // No cache and no timer: every negotiation asks again.
    expect(first.available).toHaveBeenCalledTimes(2)

    current = undefined
    expect(await describeCapabilities(router)).toEqual(BASE_CAPABILITIES)
    expect(first.available).toHaveBeenCalledTimes(2)
  })

  it('logs one debug line per negotiation saying why the feature was or was not announced', async () => {
    const rows: { name: string; resolve: () => DeckPanelReadServiceLike | undefined; options?: DeckPanelReadHostOptions; outcome: string }[] = [
      { name: 'available', resolve: () => deckService().service, outcome: 'available' },
      { name: 'service missing', resolve: () => undefined, outcome: 'service-missing' },
      { name: 'deck says unavailable with a reason', resolve: () => deckService({ available: vi.fn(async () => ({ available: false, reason: 'load-failed' })) }).service, outcome: 'unavailable:load-failed' },
      { name: 'unsafe reason is not logged', resolve: () => deckService({ available: vi.fn(async () => ({ available: false, reason: '/Users/me/repo' })) }).service, outcome: 'unavailable' },
      { name: 'probe throws with a path', resolve: () => deckService({ available: vi.fn(() => { throw new Error('ENOENT /Users/me/secret') }) }).service, outcome: 'probe-failed' },
      { name: 'probe never answers', resolve: () => deckService({ available: vi.fn(() => new Promise(() => undefined)) }).service, options: { probeTimeoutMs: 20 }, outcome: 'probe-timeout' },
      { name: 'answer is not an object', resolve: () => deckService({ available: vi.fn(async () => true) }).service, outcome: 'probe-bad-answer' },
    ]
    await runScenarios(rows.map(row => ({ name: row.name, run: async () => {
      const { router, logger } = routerFor(row.resolve, row.options)
      await describeCapabilities(router)
      const lines = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.filter(([message]) => message === 'deck panel read availability')
      expect(lines).toEqual([['deck panel read availability', { outcome: row.outcome }]])
      expect(JSON.stringify((logger.debug as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/\/Users|ENOENT|secret/)
    } })))
  })

  it('refuses every other operation and every extra or malformed key without calling the deck', async () => {
    const { service, call, available, anythingElse } = deckService()
    const { router } = routerFor(() => service)
    const notAllowed: [string, unknown][] = [
      ['comments', { operation: 'comments', sessionId: 'sess-1', key: '83' }],
      ['write', { operation: 'update', sessionId: 'sess-1', key: '83', body: 'x' }],
      ['close', { operation: 'close', sessionId: 'sess-1', key: '83' }],
      ['other host method', { operation: 'host.call', sessionId: 'sess-1' }],
      ['case variant', { operation: 'Tree', sessionId: 'sess-1' }],
      ['padded name', { operation: 'tree ', sessionId: 'sess-1' }],
      ['prototype name', { operation: 'constructor', sessionId: 'sess-1' }],
      ['proto name', { operation: '__proto__', sessionId: 'sess-1' }],
      ['missing operation', { sessionId: 'sess-1' }],
      ['not an object', 'tree'],
      ['null', null],
      ['array', ['tree', 'sess-1']],
    ]
    // The schema itself is covered in the protocol package; here it is enough that a refusal never reaches the deck.
    const badRequest: [string, unknown][] = [
      ['tree with cwd', { operation: 'tree', sessionId: 'sess-1', cwd: '/Users/me/project' }],
      ['ticket with path', { operation: 'ticket', sessionId: 'sess-1', key: '83', path: '/tmp' }],
      ['tree with key', { operation: 'tree', sessionId: 'sess-1', key: '83' }],
      ['ticket without key', { operation: 'ticket', sessionId: 'sess-1' }],
      ['blank session', { operation: 'tree', sessionId: '   ' }],
    ]
    await runScenarios([
      ...notAllowed.map(([name, params]) => ({ name, run: async () => { expect(failureKind(await read(router, params))).toBe('operation-not-allowed') } })),
      ...badRequest.map(([name, params]) => ({ name, run: async () => { expect(failureKind(await read(router, params))).toBe('bad-request') } })),
    ])
    expect(call).not.toHaveBeenCalled()
    expect(available).not.toHaveBeenCalled()
    expect(anythingElse).not.toHaveBeenCalled()
  })

  it('exposes no other deck route or method through the relay', async () => {
    const { service, call, available, anythingElse } = deckService()
    const { router } = routerFor(() => service)
    await runScenarios(['deck.panel.read.tree', 'deck.panel.read.ticket', 'deck.panel.write', 'deck.panel.comments.write', 'deck.call', 'deck.host.call', 'dsws.call'].map(method => ({
      name: method, run: async () => {
        const response = await router.handle({ v: 1, id: 'req-' + method, type: 'rpc.request', timestamp: Date.now(), payload: { method, params: { sessionId: 'sess-1' } } } as RemoteMessage)
        expect(response).toMatchObject({ type: 'rpc.error', payload: { code: 'METHOD_NOT_FOUND' } })
      },
    })))
    expect(call).not.toHaveBeenCalled()
    expect(available).not.toHaveBeenCalled()
    expect(anythingElse).not.toHaveBeenCalled()
  })

  it('scopes the read by session: a reply for another session never reaches the phone', async () => {
    const { service } = deckService({ call: vi.fn(async () => treeReply('someone-elses-session')) })
    const { router } = routerFor(() => service)
    const response = await read(router, { operation: 'tree', sessionId: 'sess-1' })
    expect(result(response)).toMatchObject({ ok: false, error: { kind: 'bad-reply' } })
    expect(JSON.stringify(result(response))).not.toContain('containers')
    expect(JSON.stringify(result(response))).not.toContain('someone-elses-session')

    // The deck answers with the trimmed session id, so a padded request is the same session.
    const trimmed = deckService({ call: vi.fn(async () => treeReply('sess-1')) })
    expect(result(await read(routerFor(() => trimmed.service).router, { operation: 'tree', sessionId: '  sess-1 ' }))).toEqual(treeReply())
  })

  it('asks the relay session authority first and never lets an unknown session reach the deck', async () => {
    const hang: DeckPanelReadSessionAuthority = (_id, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))) })
    const rows: { name: string; authority: DeckPanelReadSessionAuthority; options?: DeckPanelReadHostOptions; kind: string }[] = [
      { name: 'session not visible to this peer', authority: async () => undefined, kind: 'session' },
      { name: 'authority answers with an empty workspace', authority: async () => '', kind: 'session' },
      { name: 'authority throws with a path in the message', authority: async () => { throw new Error('ENOENT /Users/me/private-repo') }, kind: 'session' },
      { name: 'authority never answers', authority: hang, options: { timeoutMs: 20 }, kind: 'timeout' },
    ]
    await runScenarios(rows.map(row => ({ name: row.name, run: async () => {
      const { service, call } = deckService()
      const { router } = routerFor(() => service, row.options, row.authority)
      const response = await read(router, { operation: 'tree', sessionId: 'sess-1' })
      expect(failureKind(response)).toBe(row.kind)
      expect(JSON.stringify(response)).not.toMatch(/\/Users|ENOENT|private-repo/)
      expect(call).not.toHaveBeenCalled()
    } })))

    // The authority is asked about the trimmed id, and only the session id ever reaches the deck: not the workspace it returned.
    const authority = vi.fn<DeckPanelReadSessionAuthority>(async () => '/Users/me/the-workspace')
    const { service, call } = deckService({ call: vi.fn(async () => treeReply('sess-1')) })
    await read(routerFor(() => service, undefined, authority).router, { operation: 'tree', sessionId: '  sess-1 ' })
    expect(authority.mock.calls.map(([id]) => id)).toEqual(['sess-1'])
    expect(JSON.stringify(call.mock.calls)).not.toContain('the-workspace')
  })

  it('fails closed with no fabricated data and no host error text', async () => {
    const oversizedBody = 'x'.repeat(2_000)
    const cyclic: Record<string, unknown> = { ok: true, sessionId: 'sess-1' }
    cyclic.self = cyclic
    const rows: { name: string; call: () => unknown; options?: DeckPanelReadHostOptions; kind: string }[] = [
      { name: 'deck call throws with a path in the message', call: () => { throw new Error('ENOENT /Users/me/private-repo/.git') }, kind: 'read-failed' },
      { name: 'deck call rejects with a path in the message', call: async () => { throw new Error('token ghp_secret at /Users/me') }, kind: 'read-failed' },
      { name: 'deck never answers', call: () => new Promise(() => undefined), options: { timeoutMs: 20 }, kind: 'timeout' },
      { name: 'reply over the byte bound', call: async () => ({ ok: true, sessionId: 'sess-1', ticket: { body: oversizedBody } }), options: { maxReplyBytes: 1_000 }, kind: 'oversized' },
      { name: 'reply is undefined', call: async () => undefined, kind: 'bad-reply' },
      { name: 'reply is a string', call: async () => 'ok', kind: 'bad-reply' },
      { name: 'reply is an array', call: async () => [treeReply()], kind: 'bad-reply' },
      { name: 'reply has no ok flag', call: async () => ({ sessionId: 'sess-1', containers: [] }), kind: 'bad-reply' },
      { name: 'reply ok is not a boolean', call: async () => ({ ok: 'yes', sessionId: 'sess-1' }), kind: 'bad-reply' },
      { name: 'success reply names no session', call: async () => ({ ok: true, containers: [] }), kind: 'bad-reply' },
      { name: 'reply cannot be serialized', call: async () => cyclic, kind: 'bad-reply' },
    ]
    await runScenarios(rows.map(row => ({ name: row.name, run: async () => {
      const { service } = deckService({ call: vi.fn(row.call) as unknown as DeckPanelReadServiceLike['call'] })
      const { router, logger } = routerFor(() => service, row.options)
      const response = await read(router, { operation: 'ticket', sessionId: 'sess-1', key: '83' })
      const body = result(response) as { ok: boolean; error: { kind: string; message: string } }
      expect(body.ok).toBe(false)
      expect(body.error.kind).toBe(row.kind)
      expect(Object.keys(body)).toEqual(['ok', 'error'])
      expect(Object.keys(body.error)).toEqual(['kind', 'message'])
      const wire = JSON.stringify(response)
      for (const leak of ['/Users', 'ghp_secret', 'ENOENT', 'private-repo', oversizedBody.slice(0, 50)]) expect(wire).not.toContain(leak)
      expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toMatch(/\/Users|ghp_secret|ENOENT|sess-1/)
    } })))
  })

  it('passes the deck failure on as kind and message without data, and refuses unsafe failure text', async () => {
    const rows: { name: string; reply: unknown; expected: { kind: string; message: string } }[] = [
      { name: 'deck failure with data attached', reply: { ok: false, error: { kind: 'not-found', message: 'The deck read failed (not-found)', stack: 'at /Users/me' }, containers: [{ key: '1' }] }, expected: { kind: 'not-found', message: 'The deck read failed (not-found)' } },
      { name: 'kind that is not a short code', reply: { ok: false, error: { kind: 'ENOENT: /Users/me/repo', message: 'The deck read failed' } }, expected: { kind: 'read-failed', message: 'The deck read failed' } },
      { name: 'message with a line break', reply: { ok: false, error: { kind: 'parse', message: 'bad\n    at /Users/me/x.js:1' } }, expected: { kind: 'parse', message: 'The deck read failed (parse).' } },
      { name: 'message that holds a host path', reply: { ok: false, error: { kind: 'parse', message: 'ENOENT /Users/me/repo/.git' } }, expected: { kind: 'parse', message: 'The deck read failed (parse).' } },
      { name: 'failure without an error object', reply: { ok: false }, expected: { kind: 'read-failed', message: 'The deck read failed (read-failed).' } },
    ]
    await runScenarios(rows.map(row => ({ name: row.name, run: async () => {
      const { service } = deckService({ call: vi.fn(async () => row.reply) as unknown as DeckPanelReadServiceLike['call'] })
      const response = await read(routerFor(() => service).router, { operation: 'tree', sessionId: 'sess-1' })
      expect(result(response)).toEqual({ ok: false, error: row.expected })
    } })))
  })

  it('leaves relays without the deck exactly as before', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SafeLogger
    const router = new RpcRouter(undefined, logger, undefined, undefined, () => ['transport.relay', 'harness.remote.v1'])
    expect(await describeCapabilities(router)).toEqual(BASE_CAPABILITIES)
    expect(await read(router, { operation: 'tree', sessionId: 'sess-1' })).toMatchObject({ type: 'rpc.error', payload: { code: 'FEATURE_NOT_SUPPORTED' } })
  })
})
