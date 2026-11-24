import { runScenarios } from '../../../scripts/test-scenarios.mjs'
import { createRpcRequest, type RemoteMessage, type RpcErrorPayload, type RpcResponsePayload } from '@dsh-remote/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import type { DeckPanelReadServiceLike } from '../src/deck-panel-read.js'
import type { HostIdentity, IdentityStore } from '../src/identity-store.js'
import type { SafeLogger } from '../src/logging.js'
import { HostPluginRuntime } from '../src/service.js'
import type { AuthenticatedPeerChannel } from '../src/types.js'

type Channel = AuthenticatedPeerChannel & { push(message: RemoteMessage): void; sent(): RemoteMessage[] }

/** The deck lookup is the thirteenth positional argument; everything before it keeps its default. */
function runtimeWithDeck(identities: IdentityStore, deck: () => DeckPanelReadServiceLike | undefined): HostPluginRuntime {
  return new HostPluginRuntime(config(), identities, logger(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, deck)
}

describe('deck panel read through the Host runtime', () => {
  it('serves the read over an authenticated channel and follows the deck as it appears and goes away', async () => {
    let deck: DeckPanelReadServiceLike | undefined
    const call = vi.fn(async (_operation: string, params: Record<string, unknown>) => ({ ok: true, sessionId: params.sessionId, containers: [] }))
    const runtime = runtimeWithDeck(identities(), () => deck)
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

      deck = undefined
      expect(await capabilities()).not.toContain('deck.panel.read.v1')
    } finally {
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
