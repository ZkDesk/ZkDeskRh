// ZKdesk for AI agents: a private account held by an agent's own seed. Amounts are USDG decimal
// strings ("12.5"). Every step is proven here (bb.js) and relayed by ZKdesk, so the agent needs no
// wallet and no gas; fund it with a private send to its zkd: address. Limits that bind even a
// compromised agent come from a treasury where it is Payer: mandate caps, the Owner's approval
// threshold, the transfer-count limit, and the Owner's allowed recipients and budget (in the proof,
// contract set v3.4; see payerLimits). The guards here (per payment, per day, allowed recipients
// and treasuries, relay fee) protect against a confused or prompt-injected model on the agent's own
// machine, not against someone who has the seed. One network per process (the shared config reads
// it once).
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createPublicClient, formatUnits, http, isAddress, parseUnits } from 'viem';

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
const SEED = /^0x[0-9a-fA-F]{64}$/;
const usdg = (x) => {
  if (!AMOUNT.test(String(x).trim()) || !(Number(x) > 0)) throw new Error(`Enter a USDG amount greater than zero, with up to 6 decimals (got "${x}").`);
  return parseUnits(String(x).trim(), 6);
};
const fmt = (raw) => formatUnits(raw, 6);
const hexId = (id) => '0x' + id.toString(16).padStart(64, '0');
const POLL_MS = 5_000;
const MAX_MERGES = 20; // merges per combine call (each is one relayed proof and one fee)
const DAY_MS = 86_400_000;
const off = (v) => v === null || v === undefined || v === '' || v === 'off';

const v4Private = (a, b) => a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
/** An IPv6 address as its eight 16-bit groups (an embedded dotted IPv4 tail included). */
function groups6(ip) {
  let v = ip.toLowerCase().split('%')[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    v = v.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = v.includes('::') ? v.split('::') : [v, null];
  const h = head ? head.split(':') : [];
  const r = rest === null ? [] : rest ? rest.split(':') : [];
  const fill = rest === null ? [] : Array(8 - h.length - r.length).fill('0');
  return [...h, ...fill, ...r].map((x) => parseInt(x || '0', 16));
}
/**
 * Loopback, private, link-local, unique- and site-local addresses, and IPv6 forms that embed an IPv4
 * one (mapped, compatible, NAT64, 6to4): never fetched for a model. allowHttp (tests only) skips this.
 */
export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return v4Private(a, b);
  }
  if (isIP(ip) !== 6) return true;
  const g = groups6(ip);
  const v4 = (hi) => v4Private(hi >> 8, hi & 0xff);
  if (g.slice(0, 7).every((x) => x === 0)) return g[7] <= 1; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6]); // ::ffff:a.b.c.d, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6]); // NAT64
  if (g[0] === 0x2002) return v4(g[1]); // 6to4
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0;
}

/**
 * Notes of `asset` paid to this account by others, newest first. Only notes in the tree count: a
 * deposit in screening can still be taken back by its sender, and a refunded one never arrived. A
 * note made by a transaction that also spent one of our notes is our own change, not a payment.
 * pending: return the deposits still in screening instead.
 */
export function receivedNotes(notes, asset, since = 0, { pending = false } = {}) {
  const own = new Set(notes.map((n) => n.spentIn).filter(Boolean));
  const wanted = pending ? ['pending'] : ['unspent', 'spent'];
  return notes
    .filter((n) => BigInt(n.asset) === BigInt(asset) && n.tx && !own.has(n.tx) && Number(n.block) > Number(since) && wanted.includes(n.status))
    .sort((a, b) => Number(BigInt(b.block) - BigInt(a.block)));
}

/**
 * Rolling 24-hour spend record in a file only this user can read (0600). check() refuses an
 * outflow (amount plus fee) that would pass the cap; add() records it before it is sent, so a
 * crash mid-payment still counts.
 */
export function spendLog(file, cap, now = () => Date.now()) {
  const read = () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')).filter((e) => now() - e.t < DAY_MS);
    } catch {
      return [];
    }
  };
  const total = () => read().reduce((t, e) => t + BigInt(e.raw), 0n);
  return {
    total,
    check(raw) {
      if (cap !== null && total() + raw > cap) throw new Error(`This payment (${fmt(raw)} USDG with the relay fee) would pass this agent's limit of ${fmt(cap)} USDG per 24 hours (ZKDESK_MAX_PER_DAY); ${fmt(total())} already used.`);
    },
    /** Records an outflow (or, negative, releases one: pass the reservation's own time t). Returns t. */
    add(raw, t = now()) {
      writeFileSync(file, JSON.stringify([...read(), { t, raw: raw.toString() }]), { mode: 0o600 });
      return t;
    },
  };
}

/** A new agent seed (32 random bytes, hex). Whoever holds it can spend what the agent can. */
export const newSeed = () => '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

/**
 * Opens the agent's account. api: the ZKdesk site whose relayer is used; rpc: optional chain RPC.
 * Guards (USDG strings; null or 'off' disables): maxPerTx, maxPerDay (rolling 24 h, fees included,
 * kept in stateDir), maxFee (per relay step). allowTo: if set, the only zkd:/0x recipients the agent
 * may pay (mandates excepted: their recipients are fixed when the mandate is created). treasuries: if set,
 * the only treasury ids the agent acts in.
 */
export async function createAgent({
  seed, network = 'mainnet', api = 'https://zkdesk.tech', rpc, onStatus = () => {},
  maxPerTx = null, maxPerDay = null, maxFee = null, allowTo = null, treasuries: allowTreasuries = null, stateDir = join(homedir(), '.zkdesk'),
  allowHttp = false,
}) {
  if (!SEED.test(seed ?? '')) throw new Error('The agent seed must be 32 bytes of hex (0x + 64 characters). Make one with: node agent/cli.mjs keygen');
  if (!['mainnet', 'testnet'].includes(network)) throw new Error('network must be "mainnet" or "testnet".');
  if (globalThis.ZKDESK_NETWORK && globalThis.ZKDESK_NETWORK !== network) throw new Error(`This process already uses ${globalThis.ZKDESK_NETWORK}; one network per process.`);
  globalThis.ZKDESK_NETWORK = network;
  const [config, { agentKeys, zkAddress, parseZkAddress }, zk, { createProver }, { createTransport }, { currentPeriod, KINDS }, { paymentLink, readPaymentLink }, { payerScoped, payerSpent }] = await Promise.all([
    import('../src/lib/chain/config.js'), import('../src/lib/zk/keys.js'), import('../src/lib/zk/client.js'),
    import('../src/lib/zk/prover.js'), import('../src/lib/zk/transport.js'), import('../src/lib/zk/mandate.js'), import('../src/lib/zk/request-link.js'),
    import('../src/lib/zk/ledger.js'),
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
  const client = zk.createClient({ publicClient, keys, prove, relay, requests: mailbox, onStatus, maxFee: off(maxFee) ? null : usdg(maxFee) });
  const USDG = deployment.usdg;

  const zkTo = (to) => {
    const parsed = parseZkAddress(to);
    if (!parsed) throw new Error(`Not a ZKdesk private address (zkd: followed by 128 hex characters): "${to}".`);
    return parsed;
  };
  // Recipients compare in canonical form: zkd: lower-case, 0x lower-case.
  const canon = (to) => (isAddress(to ?? '') ? to.toLowerCase() : zkAddress(zkTo(to)));
  const allowed = off(allowTo) ? null : new Set((Array.isArray(allowTo) ? allowTo : String(allowTo).split(',')).map((x) => x.trim()).filter(Boolean).map(canon));
  const onlyTreasuries = off(allowTreasuries) ? null : new Set((Array.isArray(allowTreasuries) ? allowTreasuries : String(allowTreasuries).split(',')).map((x) => x.trim().toLowerCase()).filter(Boolean));
  const perTx = off(maxPerTx) ? null : usdg(maxPerTx);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const day = spendLog(join(stateDir, `agent-${network}-${keys.owner.toString(16).slice(0, 16)}.json`), off(maxPerDay) ? null : usdg(maxPerDay));

  /**
   * Every outflow passes here before anything is proven: the amount, the recipient, then the day's
   * total with the relay fee (a voucher step pays voucherPrice fees), recorded before sending. The step
   * then runs with that fee as its ceiling (a relay cannot raise it mid-step). If it fails and the
   * client submitted nothing to the relay (a voucher self-transfer counts), the reservation is released.
   */
  // Steps that move money run one at a time, also when the SDK is used directly (the fee ceiling and the
  // spend record belong to one step at a time).
  let lock = Promise.resolve();
  const serial = (fn) => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };
  function spend(amount, to, step, { vouchers = 0 } = {}) {
    return serial(async () => {
      const raw = usdg(amount);
      if (perTx !== null && raw > perTx) throw new Error(`${fmt(raw)} USDG is above this agent's limit of ${fmt(perTx)} USDG per transaction (ZKDESK_MAX_PER_TX).`);
      if (to !== null && allowed && !allowed.has(canon(to))) throw new Error(`${to.slice(0, 18)}… is not on this agent's list of allowed recipients (ZKDESK_ALLOW_TO).`);
      const { fee, voucherPrice } = await client.quoteFee(USDG);
      const total = raw + (vouchers ? fee * voucherPrice * BigInt(vouchers) : fee);
      day.check(total);
      const at = day.add(total);
      client.setFeeCeiling({ fee, voucherPrice });
      const sentBefore = client.relaysSent;
      try {
        return await step(raw);
      } catch (error) {
        if (client.relaysSent === sentBefore) day.add(-total, at);
        throw error;
      } finally {
        client.setFeeCeiling(null);
      }
    });
  }
  // The relay's word is checked against the chain before reporting a payment as made.
  async function done(r) {
    if (r?.status !== 'confirmed' || !r.txHash) return { confirmed: false, status: r?.status ?? 'unknown' };
    const receipt = await publicClient.getTransactionReceipt({ hash: r.txHash });
    if (receipt.status !== 'success') throw new Error(`The relay reported success but the transaction failed on-chain: ${config.explorerTx(r.txHash)}`);
    return { confirmed: true, tx: config.explorerTx(r.txHash) };
  }
  // Only treasuries where the agent can act (and, if set, on its list); names come from their Owners.
  const mine = () => client.ledgers().filter((l) => ['Owner', 'Treasurer', 'Payer'].some((r) => l.roles.includes(r)) && (!onlyTreasuries || onlyTreasuries.has(hexId(l.owner))));
  async function treasury(id) {
    await client.sync();
    const L = mine().find((l) => hexId(l.owner) === String(id).toLowerCase());
    if (!L) throw new Error(`This agent cannot act in treasury ${id}. List the ones it can with treasuries().`);
    return L;
  }
  const mover = (L) => ['Owner', 'Treasurer', 'Payer'].find((r) => L.roles.includes(r));
  // The Payer's allow list and budget, as the treasury's members read them. Payments the Owner
  // approves (above ownerApprovalAbove) are outside these limits.
  const PERIOD_NAMES = { 86400: 'day', 604800: 'week', 2592000: '30 days' };
  function payerLimits(L) {
    const c = L.config;
    if (!payerScoped(c)) return null;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const spent = L.budget ? payerSpent(L, now) : null;
    const listed = c.allow.flatMap((x, i) => (!x ? [] : [c.allowPubs[i] ? zkAddress({ owner: x, encPub: c.allowPubs[i] }) : x < 2n ** 160n ? `0x${x.toString(16).padStart(40, '0')}` : `owner key 0x${x.toString(16)}`]));
    return {
      allowedRecipients: listed.length ? listed : null,
      budget: c.budget ? fmt(c.budget) : null,
      budgetPeriod: c.budget ? (c.budgetPeriod ? PERIOD_NAMES[Number(c.budgetPeriod)] ?? `${c.budgetPeriod} seconds` : 'lifetime') : null,
      spentThisPeriod: spent === null ? null : fmt(spent),
      leftThisPeriod: c.budget && spent !== null ? fmt(c.budget > spent ? c.budget - spent : 0n) : null,
    };
  }
  async function balance() {
    await client.sync();
    const notes = client.notes().filter((n) => BigInt(n.asset) === BigInt(USDG) && n.status === 'unspent');
    return {
      usdg: fmt(client.balance(USDG)), notes: notes.length, largestNote: fmt(notes.reduce((m, n) => (n.amount > m ? n.amount : m), 0n)),
      inScreening: fmt(client.balance(USDG, 'pending')), spentLast24h: fmt(day.total()), network,
    };
  }
  // The client's two-note limit, told the agent's way.
  const hinted = (error) => {
    if (/spans more than two private notes/.test(error?.message ?? '')) throw new Error("This amount spans more than two of the agent's notes. Call zkdesk_combine first, or pay a smaller amount.");
    throw error;
  };
  async function send({ to, amount }) {
    const dest = zkTo(to);
    return done(await spend(amount, to, (raw) => client.send({ amount: raw, to: dest }).catch(hinted)));
  }
  async function pay(treasuryId, { to, amount }) {
    const L = await treasury(treasuryId);
    const dest = isAddress(to ?? '') ? { recipient: to } : { to: zkTo(to) };
    // Above the threshold an agent that is also the Owner approves first: a second voucher.
    const vouchers = L.roles.includes('Owner') && usdg(amount) > L.config.dualThreshold ? 2 : 1;
    const r = await spend(amount, to, (raw) => client.ledgerAct(L, mover(L), { action: 'transfer', amount: raw, ...dest }), { vouchers });
    if (r?.requested) return { requested: true, message: `Above ${fmt(L.config.dualThreshold)} USDG: sent to the treasury Owner for approval. Complete it once approved.` };
    return done(r);
  }
  const blockTimes = new Map();
  const timeOf = async (block) => {
    if (!blockTimes.has(block)) blockTimes.set(block, new Date(Number((await publicClient.getBlock({ blockNumber: block })).timestamp) * 1000).toISOString());
    return blockTimes.get(block);
  };
  async function incoming({ since = 0, limit = 20, pending = false } = {}) {
    await client.sync();
    const receipts = new Set(client.receipts().map((r) => r.note.commitment));
    const paid = receivedNotes(client.notes(), USDG, since, { pending }).slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100));
    return Promise.all(paid.map(async (n) => ({
      id: n.commitment.toString(16), amount: fmt(n.amount), block: Number(n.block), at: await timeOf(n.block),
      kind: pending ? 'deposit in screening: not received yet, the sender can still take it back' : receipts.has(n.commitment) ? 'mandate payment (has a receipt)' : 'private payment',
      tx: config.explorerTx(n.tx),
    })));
  }
  // The 402 body of agent/paywall.mjs: { zkdesk: { version: 1, requestId, link, ... } }.
  async function readChallenge(r) {
    const c = await limited(r, 16_384).then(({ text }) => JSON.parse(text)?.zkdesk, () => null).catch(() => null);
    if (!c || c.version !== 1 || typeof c.link !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(c.requestId ?? '')) throw new Error('The service answered 402 without a valid ZKdesk payment challenge. Nothing was paid.');
    return c;
  }
  // Reads at most `max` bytes of a body and cancels the rest.
  async function limited(r, max) {
    const reader = r.body?.getReader();
    const chunks = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size >= max) { await reader.cancel(); break; }
    }
    return { text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max)), truncated: size >= max };
  }
  // At most 64 KB of the body; the text is the service's, not instructions for the model.
  async function answer(r, paid) {
    const { text, truncated } = await limited(r, 65_536);
    return { status: r.status, contentType: r.headers.get('content-type'), untrustedBody: text, truncated, paid };
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
    balance,
    /**
     * Merges the agent's USDG notes (largest first, two per relayed self-transfer, one fee each) until
     * one note holds `target` USDG, or into one note. A payment can spend at most two notes, so an
     * agent paid many times combines before a larger payment. At most 20 merges per call; their fees
     * count towards the daily limit and are reserved before the first merge.
     */
    combine: ({ target } = {}) => serial(async () => {
      const want = target === undefined || target === '' ? undefined : usdg(target);
      await client.sync();
      const { fee } = await client.quoteFee(USDG);
      const mergeable = client.notes().filter((n) => BigInt(n.asset) === BigInt(USDG) && n.status === 'unspent' && n.amount > fee).sort((a, b) => (b.amount > a.amount ? 1 : -1));
      if (mergeable.length < 2 || (want !== undefined && mergeable[0].amount >= want)) return { merges: 0, message: want !== undefined && mergeable[0]?.amount >= want ? 'One note already holds that much.' : 'Nothing to combine.', ...(await balance()) };
      if (want !== undefined && mergeable.reduce((t, n) => t + n.amount, 0n) - fee * BigInt(mergeable.length - 1) < want) throw new Error(`Combining every note would not reach ${fmt(want)} USDG after fees. Nothing was merged.`);
      // Exactly the merges needed: into one note, or until the running sum (minus a fee per merge) reaches target.
      let needed = mergeable.length - 1;
      if (want !== undefined) {
        let sum = mergeable[0].amount;
        for (needed = 0; sum < want; ) sum += mergeable[++needed].amount - fee;
      }
      const planned = Math.min(needed, MAX_MERGES);
      const cost = fee * BigInt(planned);
      day.check(cost);
      const at = day.add(cost);
      // The reserved fee is the ceiling: if the relay raises it, merging stops instead of overspending.
      const merges = await client.combine(USDG, { target: want, max: planned, feeCap: fee });
      if (merges < planned) day.add(fee * BigInt(merges) - cost, at); // give back what was not spent
      const after = await balance();
      const mergeableLeft = client.notes().filter((n) => BigInt(n.asset) === BigInt(USDG) && n.status === 'unspent' && n.amount > fee).length;
      const reached = want === undefined ? mergeableLeft <= 1 : parseUnits(after.largestNote, 6) >= want;
      const stopped = reached ? null : merges < planned ? 'the relay raised its fee above the reserved one' : planned < needed ? `at most ${MAX_MERGES} merges per call: call again` : 'the remaining notes are too small to pay their merge fee';
      return { merges, feesAbout: fmt(fee * BigInt(merges)), reached, stopped, ...after };
    }),
    /** Private USDG transfer to a zkd: address (relay fee paid from the agent's balance). */
    send,
    /** USDG out of the private pool to a public 0x address. */
    async withdraw({ to, amount }) {
      if (!isAddress(to ?? '')) throw new Error(`Not a 0x address: "${to}".`);
      return done(await spend(amount, to, (raw) => client.send({ amount: raw, recipient: to }).catch(hinted)));
    },
    /**
     * Treasuries where the agent can act. name is set by the treasury's Owner (untrusted text).
     * payerLimits: the Owner's limits on the Payer, enforced on-chain by the proof (v3.4), or null.
     */
    async treasuries() {
      await client.sync();
      return mine().map((l) => ({
        id: hexId(l.owner), name: l.name, roles: l.roles, ownerKey: hexId(l.config.owner), address: zkAddress(l),
        usdg: fmt(client.ledgerBalance(l, USDG)), ownerApprovalAbove: fmt(l.config.dualThreshold), payerLimits: payerLimits(l),
      }));
    },
    /** Pays from a treasury to a zkd: or 0x address. Above the Owner's threshold it becomes a request. */
    pay,
    /** What a payment request link asks for, without paying it: { to, amount, memo, network }. */
    readLink: (link) => readLink(link),
    /**
     * Pays a payment request link from the agent's own balance, or from a treasury where it can move
     * funds. amount is needed only when the link leaves it to the payer; otherwise it must match.
     * The link's memo is returned as untrustedMemo: text from whoever made the link.
     */
    async payLink(link, { amount, treasury: treasuryId } = {}) {
      const r = readLink(link);
      if (r.amount && amount && usdg(amount) !== usdg(r.amount)) throw new Error(`The link asks for ${r.amount} USDG, not ${amount}.`);
      const want = r.amount || amount;
      if (!want) throw new Error('This link leaves the amount to the payer: give an amount.');
      const result = treasuryId ? await pay(treasuryId, { to: r.to, amount: want }) : await send({ to: r.to, amount: want });
      return { ...result, amount: want, to: r.to, untrustedMemo: r.memo || null };
    },
    /**
     * A payment request link to the agent, or to a treasury it can act in. Nothing is posted. With an
     * amount, a few millionths of a USDG are added (unless exact) so each link's payment is told apart
     * by its amount; wait for it with waitForPayment({ amount: readLink(link).amount }).
     */
    async requestLink({ amount = '', memo = '', treasury: treasuryId, exact = false } = {}) {
      let asked = amount;
      if (amount) {
        const raw = usdg(amount) + (exact ? 0n : BigInt(1 + Math.floor(Math.random() * 999)));
        asked = fmt(raw);
      }
      const to = treasuryId ? zkAddress(await treasury(treasuryId)) : zkAddress(keys);
      return paymentLink(api, { to, amount: asked, memo, network }).toString();
    },
    /** Approval requests of a treasury (amounts in USDG). */
    async requests(treasuryId) {
      const L = await treasury(treasuryId);
      return (await client.ledgerRequests(L)).map((r) => ({ id: r.id, status: r.status, mine: r.mine, amount: fmt(r.amount), to: r.to ? zkAddress(r.to) : r.recipient }));
    },
    /** Sends a transfer this agent requested, once the Owner approved it (the Owner chose its recipient). */
    async complete(treasuryId, requestId) {
      const L = await treasury(treasuryId);
      const r = (await client.ledgerRequests(L)).find((x) => String(x.id) === String(requestId));
      if (!r) throw new Error(`No request ${requestId} in this treasury.`);
      if (r.status !== 'Approved') throw new Error(`Request ${requestId} is ${r.status}, not Approved.`);
      day.check((await client.quoteFee(USDG)).fee * 2n);
      return done(await client.completeRequest(L, r));
    },
    /** Payment mandates of a treasury: recipient, cap per period, expiry, status. label is set by the Owner. */
    async mandates(treasuryId) {
      const L = await treasury(treasuryId);
      const now = Math.floor(Date.now() / 1000);
      return client.mandates(L).map((m) => ({
        id: hexId(m.commit), kind: KINDS[Number(m.kind)], label: m.label, recipient: zkAddress({ owner: m.recipient, encPub: m.recipientEncPub }),
        cap: fmt(m.cap), periodDays: Number(m.period) / 86_400, expires: new Date(Number(m.expiry) * 1000).toISOString().slice(0, 10),
        status: m.status, paidThisPeriod: m.paid.has(currentPeriod(m, now)), asset: BigInt(m.asset) === BigInt(USDG) ? 'USDG' : 'stock',
      }));
    },
    /** Pays the current period of a mandate (amount up to its cap; the recipient is the mandate's). */
    async payMandate(treasuryId, mandateId, amount) {
      const L = await treasury(treasuryId);
      const m = client.mandates(L).find((x) => hexId(x.commit) === String(mandateId).toLowerCase());
      if (!m) throw new Error(`No mandate ${mandateId} in this treasury.`);
      return done(await spend(amount, null, (raw) => client.payMandate(L, mover(L), m, raw), { vouchers: 1 }));
    },
    /**
     * USDG paid to the agent by others, newest first: private sends, link payments, cleared deposits
     * to its address and mandate payments (not its own change). since: only after this block.
     * pending: true lists deposits still in screening instead (not received yet).
     */
    incoming,
    /**
     * Waits until a new payment arrives (of exactly `amount` USDG if given) and returns it, or
     * { received: false } after `timeoutSeconds`. Only payments after the call count, and only once
     * they can no longer be taken back: a matching deposit still in screening is reported as pending.
     */
    async waitForPayment({ amount, timeoutSeconds = 120 } = {}) {
      const want = amount === undefined || amount === '' ? null : usdg(amount);
      const seconds = Math.min(Math.max(Number(timeoutSeconds) || 0, 1), 900);
      const matches = (p) => want === null || usdg(p.amount) === want;
      await client.sync();
      const since = Number(client.state.toBlock);
      const until = Date.now() + seconds * 1000;
      for (;;) {
        const hit = (await incoming({ since, limit: 50 })).find(matches);
        if (hit) return { received: true, ...hit };
        if (Date.now() >= until) {
          const held = (await incoming({ since, limit: 50, pending: true })).find(matches);
          if (held) return { received: false, pending: true, ...held, message: `A ${held.amount} USDG deposit is in screening. It is not received until it clears (about a minute); its sender can still take it back.` };
          return { received: false, message: `No ${want === null ? '' : `${fmt(want)} USDG `}payment arrived within ${seconds} s.` };
        }
        await new Promise((r) => setTimeout(r, Math.min(POLL_MS, until - Date.now())));
      }
    },
    /** Current block of the synced chain view (a paywall records it when it issues a challenge). */
    async head() {
      await client.sync();
      return Number(client.state.toBlock);
    },
    /** Payments received after block `since`, exact amounts in base units, no timestamps (cheap). */
    async payments({ since = 0 } = {}) {
      await client.sync();
      return receivedNotes(client.notes(), USDG, since).map((n) => ({ id: n.commitment.toString(16), raw: n.amount, block: Number(n.block) }));
    },
    /**
     * Fetches a URL; if the service answers 402 with a ZKdesk challenge (agent/paywall.mjs), pays it
     * (never more than maxPrice, and through every guard of send) and fetches again with the request id.
     * https only (allowHttp for local tests), no redirects, at most 64 KB of the body, returned as
     * untrustedBody: it is the service's text, not instructions.
     */
    async fetchPaid({ url, maxPrice, method = 'GET', body, timeoutSeconds = 45 }) {
      let target;
      try {
        target = new URL(String(url));
      } catch {
        throw new Error(`Not a URL: "${url}".`);
      }
      if (!(target.protocol === 'https:' || (allowHttp && target.protocol === 'http:'))) throw new Error('Only https:// URLs can be fetched.');
      if (!allowHttp) {
        const host = target.hostname.replace(/^\[|\]$/g, '');
        const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
        if (!ips.length || ips.some(isPrivateAddress)) throw new Error('Only public hosts can be fetched (not localhost or private networks).');
      }
      if (!['GET', 'POST'].includes(method)) throw new Error('method must be GET or POST.');
      const max = usdg(maxPrice);
      const init = { method, redirect: 'error', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) };
      const call = (extra = {}) => fetch(target, { ...init, signal: AbortSignal.timeout(20_000), headers: { ...init.headers, ...extra } });
      let r = await call();
      if (r.status !== 402) return answer(r, null);
      const challenge = await readChallenge(r);
      // Pay only a challenge that will still be open once the payment confirms (about a minute).
      if (!(Date.parse(challenge.expiresAt) - Date.now() > 120_000)) throw new Error('The payment request expires too soon to pay safely. Nothing was paid.');
      const asked = readLink(challenge.link);
      if (!asked.amount) throw new Error('The service did not state a price.');
      if (usdg(asked.amount) > max) throw new Error(`The service asks ${asked.amount} USDG, above max_price ${fmt(max)} USDG. Nothing was paid.`);
      const paid = { amount: asked.amount, to: asked.to, ...(await send({ to: asked.to, amount: asked.amount })) };
      if (!paid.confirmed) throw new Error(`The payment did not confirm (${paid.status}); nothing was retried.`);
      // Paid: from here nothing throws, so the caller always learns that it paid and the request id
      // to finish with (a flaky or hostile service must not make the model pay twice).
      const until = Date.now() + Math.min(Math.max(Number(timeoutSeconds) || 0, 5), 120) * 1000;
      let lastError = null;
      for (;;) {
        try {
          r = await call({ 'x-zkdesk-request': challenge.requestId });
          if (r.status !== 402) return await answer(r, paid);
          await r.body?.cancel();
        } catch (error) {
          lastError = error?.message ?? String(error);
        }
        if (Date.now() >= until) return { status: null, paid, requestId: challenge.requestId, error: lastError, message: 'Paid, but the service has not answered with access yet. Do not pay again: retry later with this requestId in the x-zkdesk-request header.' };
        await new Promise((ok) => setTimeout(ok, 3000));
      }
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
    /**
     * Checks a receipt record against ZKdesk's MandateRegistry (anyone can; no keys used). With
     * expectedVerifier (your 0x EVM address), a receipt made out to anyone else is refused.
     */
    verifyReceipt: (record, options) => zk.verifyReceipt(publicClient, record, { expectedVerifier: options?.expectedVerifier }),
  };
}
