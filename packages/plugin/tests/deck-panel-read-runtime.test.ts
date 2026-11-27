import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import { createNoisePrologue, fromBase64Url, generateKeyPair, NoiseIkSession, toBase64Url } from '@dsh-remote/crypto'
import { createControlFrame, createRpcRequest, decodeMessage, encodeMessage, SecureMessageCodec, type RemoteMessage, type RpcErrorPayload, type RpcResponsePayload } from '@dsh-remote/protocol'
import type { ConnectionController } from '../src/connection-controller.js'
import type { HostServerApi } from '../src/server-api.js'
import { HostServerConnection } from '../src/server-connection.js'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import type { DeckPanelCommentsServiceLike } from '../src/deck-panel-comments.js'
import type { DeckPanelReadServiceLike } from '../src/deck-panel-read.js'
import type { HostIdentity, IdentityStore } from '../src/identity-store.js'
import type { SafeLogger } from '../src/logging.js'
import { HostPluginRuntime } from '../src/service.js'
import type { AuthenticatedPeerChannel } from '../src/types.js'
import type { LocalTypertGateway } from '../src/typert-gateway-contract.js'

type Channel = AuthenticatedPeerChannel & { push(message: RemoteMessage): void; sent(): RemoteMessage[] }

/** The deck lookup is the thirteenth positional argument; everything before it keeps its default. */
function runtimeWithDeck(identities: IdentityStore, deck: () => DeckPanelReadServiceLike | undefined, gateway?: LocalTypertGateway, comments?: () => DeckPanelCommentsServiceLike | undefined): HostPluginRuntime {
  const runtime = new HostPluginRuntime(config(), identities, logger(), gateway, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, deck, comments)
  // The session authority only trusts the Harness session list on a Session API generation that serves it;
  // the runtime reads the version only when a server is configured, which these tests do not need.
  ;(runtime as unknown as { harnessVersion: string }).harnessVersion = '0.2.0-rc.1'
  return runtime
}

/** A Harness whose peer can see exactly one session, answering the capability probe the way a real one does. */
function gatewayWithSession(sessionId: string): LocalTypertGateway {
  return {
    invoke: vi.fn(async () => undefined),
    dispatch: vi.fn(async (endpoint: string, payload?: { args?: Record<string, unknown> }) => {
      if (endpoint !== 'session/list') return { ok: true as const }
      return payload?.args?._request === undefined
        ? { ok: false as const, error: { code: 'gateway/arguments-invalid', message: 'Unknown argument', details: {} } }
        : { ok: true as const, value: { items: [{ sessionId, cwd: '/Users/me/the-workspace' }] } }
    }),
    open: vi.fn(async () => (async function* () { return })()),
    failure: vi.fn(() => ({ code: 'internal', message: 'failed', details: {} })),
    supportsCarrier: true,
  } as unknown as LocalTypertGateway
}

describe('deck panel read through the Host runtime', () => {
  it('serves the read over an authenticated channel and follows the deck as it appears and goes away', async () => {
    let deck: DeckPanelReadServiceLike | undefined
    const call = vi.fn(async (_operation: string, params: Record<string, unknown>) => ({ ok: true, sessionId: params.sessionId, containers: [] }))
    const runtime = runtimeWithDeck(identities(), () => deck, gatewayWithSession('sess-1'))
    const channel = fakeChannel('deck-read', 'client-phone')
    const capabilities = async () => (await rpc<{ capabilities: string[] }>(channel, 'harness.transport.describe', {})).capabilities
    try {
      await runtime.start()
      await runtime.acceptAuthenticatedPeer(channel)
      // An older deck, or one that has not published its service yet: nothing is announced and nothing is forwarded.
      expect(await capabilities()).not.toContain('deck.panel.read.v1')
      expect(await rpc(channel, 'deck.panel.read', { operation: 'tree', sessionId: 'sess-1' })).toMatchObject({ ok: false, error: { kind: 'unavailable' } })

      deck = { feature: 'deck.panel.read.v1', available: async () => ({ available: true }), call } as unknown as DeckPanelReadServiceLike
      expect(await capabilities()).toContain('deck.panel.read.v1')
      expect(await rpc(channel, 'deck.panel.read', { operation: 'tree', sessionId: 'sess-1' })).toEqual({ ok: true, sessionId: 'sess-1', containers: [] })
      expect(call).toHaveBeenCalledTimes(1)
      expect(call).toHaveBeenCalledWith('tree', { sessionId: 'sess-1' })

      // A session this peer cannot see never reaches the deck, even with the feature announced.
      expect(await rpc(channel, 'deck.panel.read', { operation: 'tree', sessionId: 'someone-elses-session' })).toMatchObject({ ok: false, error: { kind: 'session' } })
      expect(call).toHaveBeenCalledTimes(1)

      deck = undefined
      expect(await capabilities()).not.toContain('deck.panel.read.v1')
    } finally {
      await runtime.close()
    }
  })

  it('preserves old and extended deck replies over the encrypted relay without changing the request', async () => {
    const sessionId = 'sess-1'
    const identity = { key: '42', number: 42, title: 'Example issue', state: 'OPEN' }
    const url = 'https://github.com/example/repo/issues/42'
    const summary = { ...identity, url }
    const detail = {
      ...identity, labels: [{ name: 'bug' }], body: 'Example issue body', acceptanceCriteria: [],
      progress: { percent: null, note: '', updatedAt: null, entries: [] },
    }
    const actions = [{ id: 'fix', label: 'Fix', prompt: 'Fix issue #42 in example/repo.\nRead the ticket before editing.' }]
    const rows = [
      { name: 'legacy tree', request: { operation: 'tree', sessionId } as const, body: { containers: [] } },
      { name: 'legacy ticket', request: { operation: 'ticket', sessionId, key: 42 } as const, body: { ticket: detail } },
      { name: 'legacy ticket with URL', request: { operation: 'ticket', sessionId, key: '42' } as const, body: { ticket: { ...detail, url } } },
      { name: 'extended tree', request: { operation: 'tree', sessionId } as const, body: { containers: [], standaloneIssues: [summary] } },
      { name: 'extended ticket', request: { operation: 'ticket', sessionId, key: '42' } as const, body: { ticket: { ...detail, actions, url } } },
    ]
    const call = vi.fn<DeckPanelReadServiceLike['call']>()
    const deck = { feature: 'deck.panel.read.v1', available: async () => ({ available: true }), call }
    const store = identities()
    const runtime = runtimeWithDeck(store, () => deck, gatewayWithSession(sessionId))
    await runtime.start()
    const relay = testRelay(runtime, store)
    try {
      await relay.connect()
      expect(await relay.rpc('harness.transport.describe', {})).toMatchObject({ capabilities: expect.arrayContaining(['deck.panel.read.v1']) })
      await runScenarios(rows.map(({ name, request, body }) => ({ name, run: async () => {
        const { operation, ...params } = request
        const reply = { ok: true, sessionId, ...body }
        call.mockClear().mockResolvedValue(reply)
        expect(await relay.rpc('deck.panel.read', request)).toStrictEqual(reply)
        expect(call.mock.calls).toStrictEqual([[operation, params]])
      } })))
    } finally {
      await relay.close()
      await runtime.close()
    }
  })

  it('negotiates comments independently and scopes each encrypted, paginated read', async () => {
    const sessionId = 'sess-1'
    const key = '42'
    const params = { sessionId, key }
    const list = vi.fn<DeckPanelCommentsServiceLike['list']>()
    let comments: DeckPanelCommentsServiceLike | undefined
    const store = identities()
    const runtime = runtimeWithDeck(store, () => undefined, gatewayWithSession(sessionId), () => comments)
    await runtime.start()
    const relay = testRelay(runtime, store)
    const describeHost = async () => (await relay.rpc('harness.transport.describe', {})) as { capabilities: string[] }
    try {
      await relay.connect()
      expect((await describeHost()).capabilities).not.toContain('deck.panel.comments.v1')
      expect(await relay.rpc('deck.panel.comments', params)).toMatchObject({ ok: false, error: { kind: 'unavailable' } })
      comments = { feature: 'deck.panel.comments.v1', available: async () => ({ available: true }), list }
      const { capabilities } = await describeHost()
      expect(capabilities).toContain('deck.panel.comments.v1')
      expect(capabilities).not.toContain('deck.panel.read.v1')
      expect(await relay.rpc('deck.panel.comments', { ...params, sessionId: 'outside-session' })).toMatchObject({ ok: false, error: { kind: 'session' } })
      expect(await relay.rpc('deck.panel.comments', { ...params, cwd: '/another-repo' })).toMatchObject({ ok: false, error: { kind: 'bad-request' } })
      expect(list).not.toHaveBeenCalled()
      const first = { ok: true, sessionId, key, comments: [{ body: 'Olá', author: 'example' }], nextCursor: 'opaque-token' }
      list.mockResolvedValueOnce(first)
      expect(await relay.rpc('deck.panel.comments', params)).toStrictEqual(first)
      const second = { ok: true, sessionId, key, comments: [{ body: 'Second page' }], truncated: true }
      list.mockResolvedValueOnce(second)
      expect(await relay.rpc('deck.panel.comments', { ...params, cursor: first.nextCursor })).toStrictEqual(second)
      expect(list.mock.calls).toStrictEqual([[params], [{ ...params, cursor: first.nextCursor }]])
      comments = undefined
      expect((await describeHost()).capabilities).not.toContain('deck.panel.comments.v1')
    } finally {
      await relay.close()
      await runtime.close()
    }
  })

  it('never reaches the deck from a channel that is not authenticated or not trusted', async () => {
    const call = vi.fn()
    const available = vi.fn(async () => ({ available: true }))
    const deck = { feature: 'deck.panel.read.v1', available, call } as unknown as DeckPanelReadServiceLike
    const untrusted = identities()
    vi.mocked(untrusted.isTrusted).mockReturnValue(false)
    const rows: { name: string; identities: IdentityStore; mutate: (channel: Channel) => void }[] = [
      { name: 'no Noise security context', identities: identities(), mutate: channel => { (channel as { security: unknown }).security = undefined } },
      { name: 'empty membership', identities: identities(), mutate: channel => { (channel.security as { membershipId: string }).membershipId = '' } },
      { name: 'peer identity not in local trust', identities: untrusted, mutate: () => undefined },
    ]
    await runScenarios(rows.map(row => ({ name: row.name, run: async () => {
      const runtime = runtimeWithDeck(row.identities, () => deck)
      const channel = fakeChannel('deck-read-denied', 'client-phone')
      row.mutate(channel)
      try {
        await runtime.start()
        await expect(runtime.acceptAuthenticatedPeer(channel)).rejects.toBeDefined()
        channel.push(createRpcRequest('deck.panel.read' as Parameters<typeof createRpcRequest>[0], { operation: 'tree', sessionId: 'sess-1' } as never))
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(channel.sent()).toEqual([])
      } finally {
        await runtime.close()
      }
    } })))
    expect(call).not.toHaveBeenCalled()
    expect(available).not.toHaveBeenCalled()
  })
})

async function rpc<T = unknown>(channel: Channel, method: string, params: unknown): Promise<T> {
  const request = createRpcRequest(method as Parameters<typeof createRpcRequest>[0], params as never)
  channel.push(request)
  let response: RemoteMessage | undefined
  await vi.waitFor(() => {
    response = channel.sent().find(message => (message.type === 'rpc.response' || message.type === 'rpc.error')
      && (message.payload as RpcResponsePayload | RpcErrorPayload).requestId === request.id)
    expect(response).toBeDefined()
  })
  if (response!.type === 'rpc.error') throw Object.assign(new Error((response!.payload as RpcErrorPayload).message), { code: (response!.payload as RpcErrorPayload).code })
  return (response!.payload as RpcResponsePayload).result as T
}

// Only the server's socket and account directory are simulated. Use the actual Host
// relay Noise handshake, encrypted frame transport, and runtime RPC routing.
function testRelay(runtime: HostPluginRuntime, store: IdentityStore) {
  const host = { ...runtime.currentIdentity(), ...generateKeyPair() }
  const client = { ...generateKeyPair(), deviceId: 'client-phone', name: 'Phone', platform: 'android' as const, membershipId: 'membership-1' }
  vi.mocked(store.trustedPeer).mockReturnValue({ ...client, fingerprint: 'PHONE', trustedAt: 1 })
  const api = {
    baseUrl: 'https://relay.example',
    authenticate: async () => ({ accessToken: 'test-token' }),
    deviceFor: async () => ({ ...client, role: 'client', identityKey: client.publicKey }),
  } as unknown as HostServerApi
  const frames: { type: string; payload: { data: string; ciphertext: string } }[] = []
  const socket = {
    readyState: 0,
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null,
    onclose: null,
    send(data: string) { frames.push(JSON.parse(data)) },
    close() { this.readyState = 3 },
  }
  const connections = {
    accept: (channel: AuthenticatedPeerChannel) => runtime.acceptAuthenticatedPeer(channel),
    closeConnection: async () => false,
    close: async () => undefined,
  } as unknown as ConnectionController
  const server = new HostServerConnection(config(), host, store, api, connections, logger(), () => socket)
  const connectionId = 'connection-deck-relay'
  const noise = new NoiseIkSession({
    role: 'initiator', localPrivateKey: client.privateKey, localPublicKey: client.publicKey,
    remotePublicKey: host.publicKey, prologue: createNoisePrologue(connectionId, host.deviceId, client.deviceId),
  })
  const incoming = new SecureMessageCodec()
  const outgoing = new SecureMessageCodec()
  let counter = 0
  let consumedFrames = 0
  const receive = (type: Parameters<typeof createControlFrame>[0], payload: unknown) => {
    socket.onmessage?.({ data: JSON.stringify(createControlFrame(type, payload)) })
  }
  return {
    async connect() {
      server.start()
      await vi.waitFor(() => expect(socket.onopen).not.toBeNull())
      socket.readyState = 1
      socket.onopen?.({})
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'hello')).toBe(true))
      receive('hello.ack', {
        protocol: 1, serverVersion: '0.1.0', connectionSessionId: 'control-deck', heartbeatIntervalMs: 25_000,
        maxControlFrameBytes: 65_536, maxRelayFrameBytes: 1_048_576, capabilities: ['transport.relay'],
      })
      receive('connect.incoming', {
        connectionId, clientDeviceId: client.deviceId, clientIdentityKey: client.publicKey,
        authorization: 'account', preferredTransports: ['relay'],
      })
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'connect.accepted')).toBe(true))
      receive('secure.handshake', { connectionId, targetDeviceId: host.deviceId, step: 1, data: toBase64Url(noise.writeHandshake()) })
      const handshake = await vi.waitFor(() => {
        const frame = frames.find(sent => sent.type === 'secure.handshake')
        expect(frame).toBeDefined()
        return frame!
      })
      noise.readHandshake(fromBase64Url(handshake.payload.data))
      consumedFrames = frames.length
    },
    async rpc(method: Parameters<typeof createRpcRequest>[0], params: unknown) {
      const request = createRpcRequest(method, params)
      for (const fragment of outgoing.encode(encodeMessage(request))) {
        receive('relay', { connectionId, targetDeviceId: host.deviceId, counter: counter++, ciphertext: toBase64Url(noise.encrypt(fragment)) })
      }
      return vi.waitFor(() => {
        while (consumedFrames < frames.length) {
          const frame = frames[consumedFrames++]!
          if (frame.type !== 'relay') continue
          const plaintext = incoming.decode(noise.decrypt(fromBase64Url(frame.payload.ciphertext)))
          if (plaintext === undefined) continue
          const message = decodeMessage(plaintext)
          if (message.type !== 'rpc.response' && message.type !== 'rpc.error') continue
          const response = message.payload as RpcResponsePayload | RpcErrorPayload
          if (response.requestId !== request.id) continue
          if ('result' in response) return response.result
          throw new Error(`relay RPC ${method} failed: ${response.code}`)
        }
        throw new Error(`waiting for relay RPC ${method}`)
      })
    },
    async close() {
      noise.destroy()
      await server.stop()
    },
  }
}

function identities(): IdentityStore {
  const identity: HostIdentity = {
    schemaVersion: 1, deviceId: 'host-1', name: 'Host', publicKey: 'host-public-key', privateKey: 'host-private-key', fingerprint: 'HOST',
  }
  const peers = new Map([['client-phone', { deviceId: 'client-phone', name: 'Phone', platform: 'android' }]])
  return {
    loadOrCreate: vi.fn(async () => identity),
    isTrusted: vi.fn(() => true),
    listTrustedPeers: vi.fn(() => [...peers.values()]),
    trustedPeer: vi.fn((deviceId: string) => peers.get(deviceId)),
  } as unknown as IdentityStore
}

function fakeChannel(connectionId: string, peerDeviceId: string): Channel {
  let handler: (message: RemoteMessage) => void = () => undefined
  const sentMessages: RemoteMessage[] = []
  return {
    security: { protocol: 'Noise_IK_25519_ChaChaPoly_SHA256', connectionId, membershipId: 'membership-1' },
    peerDeviceId,
    peerIdentityKey: `key-${peerDeviceId}`,
    mode: 'LAN',
    send: vi.fn(async (message: RemoteMessage) => { sentMessages.push(message) }),
    close: vi.fn(async () => undefined),
    onMessage: vi.fn(next => { handler = next; return () => { handler = () => undefined } }),
    push: message => handler(message),
    sent: () => [...sentMessages],
  }
}

function config(): ResolvedConfig {
  return {
    terminal: { enabled: false },
    httpServerAllowlist: [],
    sidebar: { entry: 'standard' },
    loopback: { ports: [] },
    enabled: true,
    role: 'host',
    serverUrl: undefined,
    deviceName: 'Host',
    forceRelay: true,
    rotatePinnedPeerKey: false,
    logLevel: 'error',
    reconnect: { enabled: false, initialDelayMs: 100, maxDelayMs: 1_000, jitter: 0 },
    codex: { enabled: false, binary: 'codex' },
    cursor: { enabled: false, binary: 'agent' },
  }
}

function logger(): SafeLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SafeLogger
}
