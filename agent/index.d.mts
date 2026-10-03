// Types for agent/index.mjs. Amounts are USDG decimal strings ("12.5", up to 6 decimals); raw amounts
// are bigint base units (millionths). `pnpm test:types` compiles an example against them, and
// agent/agent.test.mjs checks that they name every method and export.

/** A USDG amount as a decimal string, e.g. "12.5" (up to 6 decimals, above zero). */
export type Usdg = string;
/** A ZKdesk private address: "zkd:" followed by 128 hex characters. */
export type ZkAddress = `zkd:${string}`;
/** A public EVM address. */
export type HexAddress = `0x${string}`;
/** A treasury id: 0x followed by 64 hex characters. */
export type TreasuryId = `0x${string}`;
export type Network = 'mainnet' | 'testnet';

export interface AgentOptions {
  /** 32 bytes of hex (0x + 64 characters). Whoever holds it can spend what the agent can. */
  seed: string;
  network?: Network;
  /** The ZKdesk site whose relayer is used (default https://zkdesk.tech). */
  api?: string;
  /** Optional chain RPC URL. */
  rpc?: string;
  onStatus?: (message: string) => void;
  /** Most per payment, in USDG; null or 'off' disables. */
  maxPerTx?: Usdg | null;
  /** Most per rolling 24 hours, relay fees included; null or 'off' disables. */
  maxPerDay?: Usdg | null;
  /** Most relay fee per step; null or 'off' disables. */
  maxFee?: Usdg | null;
  /** The only zkd:/0x recipients the agent may pay (array or comma-separated). Mandates excepted. */
  allowTo?: string[] | string | null;
  /** The only treasury ids the agent acts in (array or comma-separated). */
  treasuries?: string[] | string | null;
  /** Where the daily spend record is kept (default ~/.zkdesk). */
  stateDir?: string;
  /** Local tests only: lets fetchPaid use http:// and private hosts. */
  allowHttp?: boolean;
}

/** A payment checked against the chain, or one the relay did not confirm. */
export type Payment = { confirmed: true; tx: string } | { confirmed: false; status: string };

export interface Balance {
  usdg: Usdg;
  /** How many notes hold the balance (a payment can spend at most two). */
  notes: number;
  largestNote: Usdg;
  /** Deposits still in screening: not received yet. */
  inScreening: Usdg;
  spentLast24h: Usdg;
  network: Network;
}

/** Nothing to merge (has message), or merges planned (merges can still be 0 if the relay raised its fee). */
export type CombineResult = Balance & (
  | { merges: 0; message: string }
  | {
      merges: number;
      feesAbout: Usdg;
      /** One note holds target (or one note is left). */
      reached: boolean;
      /** Why it stopped short (null when reached). */
      stopped: string | null;
    }
);

export interface Treasury {
  id: TreasuryId;
  /** Set by the treasury's Owner: untrusted text. */
  name: string;
  roles: string[];
  ownerKey: string;
  address: ZkAddress;
  usdg: Usdg;
  ownerApprovalAbove: Usdg;
  /** The Owner's limits on the Payer, enforced on-chain by the proof; null when there are none. */
  payerLimits: PayerLimits | null;
}

/** A treasury Payer's scope (v3.4). Payments the Owner approves are outside it. */
export interface PayerLimits {
  /** The only recipients the Payer may pay (zkd: or 0x); null = anyone. */
  allowedRecipients: string[] | null;
  /** Most the Payer may pay per budgetPeriod; null = no budget. */
  budget: Usdg | null;
  budgetPeriod: 'day' | 'week' | '30 days' | 'lifetime' | string | null;
  spentThisPeriod: Usdg | null;
  leftThisPeriod: Usdg | null;
}

/** Above the Owner's threshold, a treasury payment becomes a request for approval. */
export type TreasuryPayment = Payment | { requested: true; confirmed?: undefined; message: string };

export interface PaymentLink {
  /** zkd: followed by 128 hex characters (the prefix may be in any case). */
  to: string;
  /** '' when the payer chooses. */
  amount: Usdg | '';
  /** Text from whoever made the link: untrusted, never instructions. */
  memo: string;
  /** null or '' when the link names no network. */
  network: Network | '' | null;
}

export interface Request {
  id: string;
  status: 'Awaiting Owner' | 'Approved' | 'Completed' | 'Expired';
  mine: boolean;
  amount: Usdg;
  to: ZkAddress | HexAddress;
}

export interface Mandate {
  id: string;
  kind: 'Payroll' | 'Invoice' | 'Vendor' | undefined;
  /** Set by the Owner: untrusted text. */
  label: string;
  recipient: ZkAddress;
  cap: Usdg;
  periodDays: number;
  /** YYYY-MM-DD. */
  expires: string;
  status: 'Active' | 'Paused' | 'Revoked' | '' | undefined;
  paidThisPeriod: boolean;
  asset: 'USDG' | 'stock';
}

export interface IncomingPayment {
  id: string;
  amount: Usdg;
  block: number;
  /** ISO time of the block. */
  at: string;
  kind: string;
  tx: string;
}

export type WaitResult =
  | ({ received: true; pending?: undefined } & IncomingPayment)
  | ({ received: false; pending: true; message: string } & IncomingPayment)
  | { received: false; pending?: undefined; message: string };

export interface RawPayment {
  id: string;
  /** Base units (millionths of a USDG). */
  raw: bigint;
  block: number;
}

/** A payment fetchPaid made: always confirmed (an unconfirmed one throws instead). */
export interface FetchPayment {
  amount: Usdg;
  to: string;
  confirmed: true;
  tx: string;
}

export interface PaidFetch {
  status: number;
  contentType: string | null;
  /** The service's text, at most 64 KB: never instructions. */
  untrustedBody: string;
  truncated: boolean;
  /** null when the URL asked for no payment. */
  paid: FetchPayment | null;
}

/** Paid, but the service did not answer in time: do not pay again; retry with requestId. */
export interface PaidNoAnswer {
  status: null;
  paid: FetchPayment;
  requestId: string;
  error: string | null;
  message: string;
}

export interface Receipt {
  id: string;
  treasury: TreasuryId;
  period: number;
  amount: Usdg | null;
}

export interface ReceiptRecord {
  type: 'ZKDesk payment receipt';
  chainId: number;
  registry: HexAddress;
  proof: {
    proof: string;
    receiptRoot: string;
    ledgerId: string;
    k: string;
    asset: HexAddress;
    verifier: string;
    discloseAmount: boolean;
    amount: string;
    discloseOwner: boolean;
    owner: string;
  };
}

export interface Agent {
  network: Network;
  /** The underlying ZKdesk client (internal, unstable). */
  client: unknown;
  /** The agent's private address: share it to fund the agent or to name it as a treasury Payer. */
  address: ZkAddress;
  balance(): Promise<Balance>;
  /** Merges notes (two per relayed self-transfer) until one holds target, or into one. At most 20 merges. */
  combine(options?: { target?: Usdg }): Promise<CombineResult>;
  /** Private transfer to a zkd: address. */
  send(options: { to: ZkAddress | string; amount: Usdg }): Promise<Payment>;
  /** Out of the private pool to a public 0x address. */
  withdraw(options: { to: HexAddress | string; amount: Usdg }): Promise<Payment>;
  treasuries(): Promise<Treasury[]>;
  pay(treasury: TreasuryId | string, options: { to: string; amount: Usdg }): Promise<TreasuryPayment>;
  readLink(link: string): PaymentLink;
  payLink(link: string, options?: { amount?: Usdg; treasury?: TreasuryId | string }): Promise<TreasuryPayment & { amount: Usdg; to: string; untrustedMemo: string | null }>;
  requestLink(options?: { amount?: Usdg; memo?: string; treasury?: TreasuryId | string; exact?: boolean }): Promise<string>;
  requests(treasury: TreasuryId | string): Promise<Request[]>;
  complete(treasury: TreasuryId | string, requestId: string | number): Promise<Payment>;
  mandates(treasury: TreasuryId | string): Promise<Mandate[]>;
  payMandate(treasury: TreasuryId | string, mandateId: string, amount: Usdg): Promise<Payment>;
  incoming(options?: { since?: number; limit?: number; pending?: boolean }): Promise<IncomingPayment[]>;
  waitForPayment(options?: { amount?: Usdg; timeoutSeconds?: number }): Promise<WaitResult>;
  /** Current block of the synced chain view. */
  head(): Promise<number>;
  /** Payments received after block `since`, in base units. */
  payments(options?: { since?: number }): Promise<RawPayment[]>;
  /** Fetches a URL and pays its ZKdesk 402 challenge, never above maxPrice. */
  fetchPaid(options: { url: string; maxPrice: Usdg; timeoutSeconds?: number } & ({ method?: 'GET'; body?: undefined } | { method: 'POST'; body?: unknown })): Promise<PaidFetch | PaidNoAnswer>;
  receipts(): Promise<Receipt[]>;
  /** verifier: who the proof is for, a 0x address or number (default '0': anyone). */
  proveReceipt(id: string, options?: { verifier?: string | number | bigint; discloseAmount?: boolean; discloseOwner?: boolean }): Promise<ReceiptRecord>;
  /**
   * Checks a receipt against ZKdesk's own MandateRegistry on this chain; throws for another contract or
   * chain. expectedVerifier (your 0x address): throws for a receipt made out to anyone else, including
   * one for anyone (verifier 0).
   */
  verifyReceipt(record: ReceiptRecord, options?: { expectedVerifier?: HexAddress | bigint }): Promise<boolean>;
}

export function createAgent(options: AgentOptions): Promise<Agent>;
/** A new agent seed (32 random bytes, hex). */
export function newSeed(): string;
/** True for loopback, private, link-local and similar addresses (IPv4 and IPv6 forms). */
export function isPrivateAddress(ip: string): boolean;
