// ZKdesk for AI agents: a private account held by an agent's own seed. Amounts are USDG decimal
// strings ("12.5"). Every step is proven here (bb.js) and relayed by ZKdesk, so the agent needs no
// wallet and no gas; fund it with a private send to its zkd: address. Limits that bind even a
// compromised agent come from a treasury where it is Payer: mandate caps, the Owner's approval
// threshold and the transfer-count limit. maxPerTx is only a guard on the agent's own machine.
// One network per process (the shared config reads it once).
import { readFile } from 'node:fs/promises';
import { createPublicClient, formatUnits, http, isAddress, parseUnits } from 'viem';

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
const SEED = /^0x[0-9a-fA-F]{64}$/;
const usdg = (x) => {
  if (!AMOUNT.test(String(x).trim()) || !(Number(x) > 0)) throw new Error(`Enter a USDG amount greater than zero, with up to 6 decimals (got "${x}").`);
  return parseUnits(String(x).trim(), 6);
};
const fmt = (raw) => formatUnits(raw, 6);
const hexId = (id) => '0x' + id.toString(16).padStart(64, '0');

/** A new agent seed (32 random bytes, hex). Whoever holds it can spend what the agent can. */
export const newSeed = () => '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

/** Opens the agent's account. api: the ZKdesk site whose relayer is used; rpc: optional chain RPC. */
export async function createAgent({ seed, network = 'mainnet', api = 'https://zkdesk.tech', rpc, maxPerTx = null, onStatus = () => {} }) {
  if (!SEED.test(seed ?? '')) throw new Error('The agent seed must be 32 bytes of hex (0x + 64 characters). Make one with: node agent/cli.mjs keygen');
  if (!['mainnet', 'testnet'].includes(network)) throw new Error('network must be "mainnet" or "testnet".');
  if (globalThis.ZKDESK_NETWORK && globalThis.ZKDESK_NETWORK !== network) throw new Error(`This process already uses ${globalThis.ZKDESK_NETWORK}; one network per process.`);
  globalThis.ZKDESK_NETWORK = network;
  const [config, { agentKeys, zkAddress, parseZkAddress }, zk, { createProver }, { createTransport }, { currentPeriod, KINDS }, { paymentLink, readPaymentLink }] = await Promise.all([
    import('../src/lib/chain/config.js'), import('../src/lib/zk/keys.js'), import('../src/lib/zk/client.js'),
    import('../src/lib/zk/prover.js'), import('../src/lib/zk/transport.js'), import('../src/lib/zk/mandate.js'), import('../src/lib/zk/request-link.js'),
  ]);
  const { chain, deployment, deploymentReady, apiBase } = config;
  if (!deploymentReady) throw new Error(`ZKdesk ${network} still runs older contracts. Use ${network === 'mainnet' ? 'testnet' : 'mainnet'}.`);
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const keys = agentKeys(seed, chain.id);
  const { relay, mailbox } = createTransport(`${api.replace(/\/$/, '')}${apiBase}`);
  const provers = {};
  const prove = async (kind, witness) => {
    if (!/^[a-z_]+$/.test(kind)) throw new Error(`Unknown circuit: ${kind}`);
    provers[kind] ??= readFile(new URL(`../src/lib/zk/artifacts/${kind}.json`, import.meta.url), 'utf8').then((t) => createProver(JSON.parse(t)));
    return (await provers[kind]).prove(witness);
  };
  const client = zk.createClient({ publicClient, keys, prove, relay, requests: mailbox, onStatus });
  const USDG = deployment.usdg;

  const limit = maxPerTx === null || maxPerTx === undefined || maxPerTx === '' ? null : usdg(maxPerTx);
  const amountOf = (x) => {
    const raw = usdg(x);
    if (limit !== null && raw > limit) throw new Error(`${fmt(raw)} USDG is above this agent's limit of ${fmt(limit)} USDG per transaction (ZKDESK_MAX_PER_TX).`);
    return raw;
  };
  const zkTo = (to) => {
    const parsed = parseZkAddress(to);
    if (!parsed) throw new Error(`Not a ZKdesk private address (zkd: followed by 128 hex characters): "${to}".`);
    return parsed;
  };
  const done = (r) => ({ confirmed: r?.status === 'confirmed', tx: r?.txHash ? config.explorerTx(r.txHash) : null });
  async function treasury(id) {
    await client.sync();
    const L = client.ledgers().find((l) => hexId(l.owner) === String(id).toLowerCase());
    if (!L) throw new Error(`This agent holds no role in treasury ${id}. List them with treasuries().`);
    return L;
  }
  const mover = (L) => {
    const role = ['Owner', 'Treasurer', 'Payer'].find((r) => L.roles.includes(r));
    if (!role) throw new Error(`This agent is ${L.roles.join(', ')} in "${L.name}" and cannot move its funds.`);
    return role;
  };
  const send = async ({ to, amount }) => done(await client.send({ amount: amountOf(amount), to: zkTo(to) }));
  async function pay(treasuryId, { to, amount }) {
    const L = await treasury(treasuryId);
    const raw = amountOf(amount);
    const dest = isAddress(to ?? '') ? { recipient: to } : { to: zkTo(to) };
    const r = await client.ledgerAct(L, mover(L), { action: 'transfer', amount: raw, ...dest });
    if (r?.requested) return { requested: true, message: `Above ${fmt(L.config.dualThreshold)} USDG: sent to the treasury Owner for approval. Complete it once approved.` };
    return done(r);
  }
  function readLink(link) {
    let url;
    try {
      url = new URL(String(link).trim());
    } catch {
      throw new Error(`Not a link: "${link}".`);
    }
    const r = readPaymentLink(url.searchParams);
    if (!r) throw new Error('This link is not a ZKdesk payment request (it has no valid pay= address).');
    if (r.network && r.network !== network) throw new Error(`This link is for ${r.network}; this agent is on ${network}.`);
    return r;
  }

  return {
    network, client,
    /** The agent's private address: share it to fund the agent or to name it as a treasury Payer. */
    address: zkAddress(keys),
    async balance() {
      await client.sync();
      return { usdg: fmt(client.balance(USDG)), pending: fmt(client.balance(USDG, 'pending')), network };
    },
    /** Private USDG transfer to a zkd: address (relay fee paid from the agent's balance). */
    send,
    /** USDG out of the private pool to a public 0x address. */
    async withdraw({ to, amount }) {
      if (!isAddress(to ?? '')) throw new Error(`Not a 0x address: "${to}".`);
      return done(await client.send({ amount: amountOf(amount), recipient: to }));
    },
    /** Treasuries where the agent holds a role. */
    async treasuries() {
      await client.sync();
      return client.ledgers().map((l) => ({
        id: hexId(l.owner), name: l.name, roles: l.roles, address: zkAddress(l),
        usdg: fmt(client.ledgerBalance(l, USDG)), ownerApprovalAbove: fmt(l.config.dualThreshold),
      }));
    },
    /** Pays from a treasury to a zkd: or 0x address. Above the Owner's threshold it becomes a request. */
    pay,
    /** What a payment request link asks for, without paying it: { to, amount, memo, network }. */
    readLink: (link) => readLink(link),
    /**
     * Pays a payment request link from the agent's own balance, or from a treasury where it can move
     * funds. amount is needed only when the link leaves it to the payer; otherwise it must match.
     */
    async payLink(link, { amount, treasury: treasuryId } = {}) {
      const r = readLink(link);
      if (r.amount && amount && usdg(amount) !== usdg(r.amount)) throw new Error(`The link asks for ${r.amount} USDG, not ${amount}.`);
      const want = r.amount || amount;
      if (!want) throw new Error('This link leaves the amount to the payer: give an amount.');
      const result = treasuryId ? await pay(treasuryId, { to: r.to, amount: want }) : await send({ to: r.to, amount: want });
      return { ...result, amount: want, to: r.to, memo: r.memo || null };
    },
    /** A payment request link to the agent, or to a treasury it holds a role in. Nothing is posted. */
    async requestLink({ amount = '', memo = '', treasury: treasuryId } = {}) {
      if (amount) usdg(amount);
      const to = treasuryId ? zkAddress(await treasury(treasuryId)) : zkAddress(keys);
      return paymentLink(api, { to, amount, memo, network }).toString();
    },
    /** Approval requests of a treasury (amounts in USDG). */
    async requests(treasuryId) {
      const L = await treasury(treasuryId);
      return (await client.ledgerRequests(L)).map((r) => ({ id: r.id, status: r.status, mine: r.mine, amount: fmt(r.amount), to: r.to ? zkAddress(r.to) : r.recipient }));
    },
    /** Sends a transfer this agent requested, once the Owner approved it. */
    async complete(treasuryId, requestId) {
      const L = await treasury(treasuryId);
      const r = (await client.ledgerRequests(L)).find((x) => String(x.id) === String(requestId));
      if (!r) throw new Error(`No request ${requestId} in this treasury.`);
      if (r.status !== 'Approved') throw new Error(`Request ${requestId} is ${r.status}, not Approved.`);
      return done(await client.completeRequest(L, r));
    },
    /** Payment mandates of a treasury: recipient, cap per period, expiry, status. */
    async mandates(treasuryId) {
      const L = await treasury(treasuryId);
      const now = Math.floor(Date.now() / 1000);
      return client.mandates(L).map((m) => ({
        id: hexId(m.commit), kind: KINDS[Number(m.kind)], label: m.label, recipient: zkAddress({ owner: m.recipient, encPub: m.recipientEncPub }),
        cap: fmt(m.cap), periodDays: Number(m.period) / 86_400, expires: new Date(Number(m.expiry) * 1000).toISOString().slice(0, 10),
        status: m.status, paidThisPeriod: m.paid.has(currentPeriod(m, now)), asset: BigInt(m.asset) === BigInt(USDG) ? 'USDG' : 'stock',
      }));
    },
    /** Pays the current period of a mandate (amount up to its cap). */
    async payMandate(treasuryId, mandateId, amount) {
      const L = await treasury(treasuryId);
      const m = client.mandates(L).find((x) => hexId(x.commit) === String(mandateId).toLowerCase());
      if (!m) throw new Error(`No mandate ${mandateId} in this treasury.`);
      return done(await client.payMandate(L, mover(L), m, amountOf(amount)));
    },
    /** Payments the agent received under mandates; each can be proven with proveReceipt. */
    async receipts() {
      await client.sync();
      return client.receipts().map((r) => ({ id: r.note.commitment.toString(16), treasury: hexId(r.ledgerId), period: Number(r.k), amount: BigInt(r.note.asset) === BigInt(USDG) ? fmt(r.note.amount) : null }));
    },
    /** A zero-knowledge receipt for one payment, for one verifier, disclosing only what is chosen. */
    async proveReceipt(id, { verifier = '0', discloseAmount = false, discloseOwner = false } = {}) {
      await client.sync();
      const receipt = client.receipts().find((r) => r.note.commitment.toString(16) === String(id));
      if (!receipt) throw new Error(`No received payment ${id}. List them with receipts().`);
      return client.proveReceipt(receipt, { verifier, discloseAmount, discloseOwner });
    },
    /** Checks a receipt record against the MandateRegistry (anyone can; no keys used). */
    verifyReceipt: (record) => zk.verifyReceipt(publicClient, record),
  };
}
