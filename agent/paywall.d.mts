// Types for agent/paywall.mjs. `pnpm test:types` compiles an example against them.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Agent } from './index.mjs';

/** Where a paywall keeps its state: three atomic operations. `until` is a time in ms (Date.now()). */
export interface PaywallStore {
  /** Adds the key if absent (or expired); true if added. */
  add(key: string, value: unknown, until: number): Promise<boolean>;
  get(key: string): Promise<any>;
  /** True if the key was there (and is now gone). */
  del(key: string): Promise<boolean>;
}

/** The node-redis v4+ calls redisStore uses. */
export interface RedisLike {
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

/** In-process store (the default): one process, forgotten on restart. */
export function memoryStore(options?: { now?: () => number; onChange?: ((map: Map<string, { value: unknown; until: number }>) => void) | null }): PaywallStore & { map: Map<string, { value: unknown; until: number }> };
/** One process, kept across restarts (written privately and atomically after every change). */
export function fileStore(path: string, options?: { now?: () => number }): PaywallStore & { map: Map<string, { value: unknown; until: number }> };
/** Any number of instances sharing one Redis (maxmemory-policy noeviction; one prefix per account). */
export function redisStore(client: RedisLike, options?: { prefix?: string; now?: () => number }): PaywallStore;
/** The default caller key: the socket address, an IPv6 one by its /64. */
export function socketClient(req: IncomingMessage): string;

export interface PaywallOptions {
  /** The service's own account (createAgent). */
  agent: Agent;
  /** USDG per request, e.g. "0.25". */
  price: string;
  /** How long a challenge stays open (default 300). */
  ttlSeconds?: number;
  /** The ZKdesk site the payment link opens (default https://zkdesk.tech). */
  origin?: string;
  /** Open challenges per caller, 1 to 100 (default 5). */
  perClient?: number;
  /** How often the chain is read, in ms (default 3000). */
  recheckMs?: number;
  /** Behind a reverse proxy: the client address from the header your proxy sets. */
  clientOf?: (req: IncomingMessage) => string;
  now?: () => number;
  /** Default: one memory store shared by the paywalls of this agent. */
  store?: PaywallStore;
}

export interface Paywall {
  /** true: paid, serve the request (once). false: a 400, 402, 414 or 503 has been written. Never throws. */
  guard(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createPaywall(options: PaywallOptions): Paywall;
