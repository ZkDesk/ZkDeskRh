// Agent acceptance (agent/): an AI agent's private account used through the SDK against a running
// ZKdesk site (its relayer and mailbox over HTTP), with an Owner who funds it and makes it a
// treasury's Payer. Owner deposits -> sends the agent 800 -> agent sends and withdraws -> Owner
// creates a treasury with the agent as Payer (approval above 50) -> agent pays 20 -> agent's 80 becomes
// a request -> Owner approves -> agent completes -> Owner gives the agent a 25/month mandate -> agent
// pays it once (a second pay is refused) -> agent proves the receipt and it verifies -> payment links:
// the agent pays the Owner's link (own balance, then from the treasury) and the Owner pays the agent's
// link while the agent waits for it -> incoming payments list (no change) -> the agent's
// per-transaction limit refuses 600 -> a deposit to the agent that its sender refunds during screening
// is reported as pending, never as received -> combine: a second agent paid six times cannot send an
// amount that needs three notes (hint to combine), a daily limit below the merge fees refuses before any
// merge, and after combining into one note the payment goes through.
// v3.4 Payer scope: the Owner gives the agent an allow list and a daily budget; listed payments within
// it go through, an over-budget or off-list payment is refused, and the prover cannot make a proof for
// one even with the SDK's checks off; an Owner-approved payment is outside the scope; lifting the scope
// resets it. The Owner's alert watcher reports the agent's payments, its budget and its approval requests
// once each. The spending report lists each payment with who made it (from the chain) and its recipient.
// v3.5 access end: after it every agent payment is refused (an approved one too, and by the prover),
// the watcher reports it, and the Owner extends it. Needs a local fork (it moves chain time).
// Usage (testnet or a local fork with the site served by serve.mjs-style server and DB_SCHEMA set):
//   RPC_URL_SERVER=<rpc> node scripts/ops/e2e-agent.mjs <siteUrl>
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const site = process.argv[2] ?? 'http://localhost:5199';
const RPC = process.env.RPC_URL_SERVER || undefined;
const { createAgent, newSeed } = await import('../../agent/index.mjs');
const agentSeed = newSeed();
const agent = await createAgent({ seed: agentSeed, network: 'testnet', api: site, rpc: RPC, maxPerTx: '500', onStatus: (m) => console.log(`    · agent: ${m}`) });
const { chain, deployment, apiBase } = await import('../../src/lib/chain/config.js');
const { agentKeys, deriveKeys, keyRequest, zkAddress, parseZkAddress } = await import('../../src/lib/zk/keys.js');
const { createClient } = await import('../../src/lib/zk/client.js');
const { createProver } = await import('../../src/lib/zk/prover.js');
const { createTransport } = await import('../../src/lib/zk/transport.js');
const { paymentLink, readPaymentLink } = await import('../../src/lib/zk/request-link.js');
const { default: tickHandler } = await import('../../api/cron/tick.js');

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
const provers = {};
const prove = async (kind, witness) => (await (provers[kind] ??= createProver(JSON.parse(readFileSync(`src/lib/zk/artifacts/${kind}.json`, 'utf8'))))).prove(witness);
const { relay, mailbox } = createTransport(`${site}${apiBase}`);
const keys = deriveKeys(await account.signTypedData(keyRequest(chain.id)));
const owner = createClient({ publicClient, walletClient, address: account.address, keys, prove, relay, requests: mailbox, onStatus: (m) => console.log(`    · owner: ${m}`) });
const ownerZk = zkAddress(keys);
// A local fork mines only on demand and the indexer stays a few blocks behind the head.
const mine = () => (RPC?.includes('127.0.0.1') ? publicClient.request({ method: 'anvil_mine', params: ['0x40'] }) : null);
const tick = () => new Promise((resolve) => tickHandler({ method: 'GET', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, { statusCode: 200, setHeader() {}, end: resolve }));

const step = async (name, fn) => { const t = performance.now(); console.log(`▶ ${name}`); const r = await fn(); console.log(`  ✓ ${Math.round(performance.now() - t)} ms${r === undefined ? '' : ` ${JSON.stringify(r, (_, x) => (typeof x === 'bigint' ? x.toString() : x))}`}`); return r; };
const refused = async (name, fn, pattern) => {
  try { await fn(); } catch (error) { if (!pattern.test(error.message)) throw error; console.log(`  ✓ refused (${name}): ${error.message}`); return; }
  throw new Error(`${name} was not refused`);
};
const check = (ok, what) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`  ✓ ${what}`); };
async function cleared(balance, want) {
  await new Promise((r) => setTimeout(r, (deployment.standbySeconds + 5) * 1000));
  for (let i = 0; i < 10; i++) { await mine(); await tick(); if ((await balance()) >= want) return; await new Promise((r) => setTimeout(r, 10_000)); }
  throw new Error('the deposit did not clear');
}

console.log(`Agent ${agent.address.slice(0, 22)}… on ${chain.name} via ${site}`);
await owner.sync();
if (owner.balance(deployment.usdg) < 1500_000000n) {
  await step('Owner deposits 3000 tUSDG privately', async () => {
    const before = owner.balance(deployment.usdg);
    await owner.deposit(deployment.usdg, 3000_000000n);
    await cleared(async () => { await owner.sync(); return owner.balance(deployment.usdg); }, before + 3000_000000n);
  });
}
await step('Owner sends the agent 800 tUSDG privately', () => owner.send({ amount: 800_000000n, to: parseZkAddress(agent.address) }));
const start = await step('Agent balance', () => agent.balance());
check(Number(start.usdg) >= 800, 'the agent sees its funds');
await step('Agent sends 10 back privately', () => agent.send({ to: ownerZk, amount: '10' }));
await step('Agent withdraws 10 to a 0x address', () => agent.withdraw({ to: account.address, amount: '10' }));

const ledgerId = await step('Owner creates a treasury with the agent as Payer (approval above 50)', () => owner.createLedger({
  name: 'Agent treasury', payer: parseZkAddress(agent.address), allocCap: 1000_000000n, dualThreshold: 50_000000n,
}));
const id = '0x' + ledgerId.toString(16).padStart(64, '0');
await owner.sync();
const L = () => owner.ledgers().find((l) => l.owner === ledgerId);
await step('Owner deposits 400 tUSDG into the treasury', async () => {
  await owner.deposit(deployment.usdg, 400_000000n, { owner: L().owner, encPub: L().encPub });
  await cleared(async () => Number((await agent.treasuries()).find((t) => t.id === id)?.usdg ?? 0) * 1e6, 400_000000);
});
// v3.19 alerts: the Owner's watcher (agent/watch.mjs) with the treasury's view key, posting to a local
// webhook. Its first check only learns what is already there.
const hooks = [];
const { createServer } = await import('node:http');
const hookServer = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push(JSON.parse(b)); res.end('ok'); }); });
await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
const { mkdtempSync: mkdtemp } = await import('node:fs');
const { tmpdir: tmp } = await import('node:os');
const { join: pjoin } = await import('node:path');
const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const watchDir = mkdtemp(pjoin(tmp(), 'zkd-watch-'));
// Asynchronous: the webhook above runs in this process, so it must keep answering while the watcher runs.
const watchOnce = async (mode = '--once') => (await promisify(execFile)(process.execPath, ['agent/watch.mjs', mode], {
  env: { ...process.env, ZKDESK_ALERT_TELEGRAM_TOKEN: '', ZKDESK_ALERT_TELEGRAM_CHAT: '', ZKDESK_VIEW_KEY: '0x' + L().lsk.toString(16).padStart(64, '0'), ZKDESK_NETWORK: 'testnet', ZKDESK_API: site, ZKDESK_RPC: RPC ?? '', ZKDESK_STATE_DIR: watchDir, ZKDESK_ALERT_WEBHOOK_URL: `http://127.0.0.1:${hookServer.address().port}/hook` },
  encoding: 'utf8',
}).catch((error) => { throw new Error(`watcher failed (exit ${error.code}): ${error.stderr || error.message}`); })).stdout;
await step("Owner's alert watcher learns the treasury", async () => { await owner.sync(); return (await watchOnce()).trim().split('\n').at(-1); });
check(hooks.length === 0, 'the first check sends nothing (no replay of history)');
// 3.23: --test opens the treasury and sends one test alert, without touching the watcher's state.
const tested = await step('Owner tests the alert setup (--test)', () => watchOnce('--test'));
check(/Viewing key opens "Agent treasury"/.test(tested) && /Webhook: test alert delivered/.test(tested), 'the test reports the treasury and the delivery');
check(hooks.length === 1 && hooks[0].event === 'test' && /alerts are set up for "Agent treasury"/.test(hooks[0].text), 'the test alert arrived');
hooks.length = 0;
const seen = await step('Agent lists its treasuries', () => agent.treasuries());
check(seen.find((t) => t.id === id)?.roles.join() === 'Payer', 'the agent holds only the Payer role');
const paid = await step('Agent pays 20 from the treasury (below the threshold)', () => agent.pay(id, { to: ownerZk, amount: '20' }));
check(paid.confirmed, 'relayed and confirmed');
const asked = await step('Agent pays 80 (above the threshold)', () => agent.pay(id, { to: ownerZk, amount: '80' }));
check(asked.requested === true, 'it became a request for the Owner');
await step('Owner approves the request', async () => {
  await owner.sync();
  const r = (await owner.ledgerRequests(L())).find((x) => x.status === 'Awaiting Owner');
  return owner.approveRequest(L(), r).then(() => r.id);
});
const approved = (await agent.requests(id)).find((r) => r.status === 'Approved' && r.mine);
check(approved?.amount === '80', 'the agent sees its request approved');
check((await step('Agent completes it', () => agent.complete(id, approved.id))).confirmed, 'the approved transfer is sent');

const expiry = Math.floor(Date.now() / 1000) + 30 * 86_400;
await step('Owner gives the agent a 25 tUSDG monthly mandate', () => owner.createMandate(L(), 'Owner', { kind: 'Payroll', to: parseZkAddress(agent.address), label: 'agent', cap: 25_000000n, period: 'Monthly', expiry }));
const [mandate] = await step('Agent lists the mandates', () => agent.mandates(id));
check(mandate?.cap === '25' && !mandate.paidThisPeriod, 'one unpaid 25 tUSDG mandate');
check((await step('Agent pays the mandate', () => agent.payMandate(id, mandate.id, '25'))).confirmed, 'mandate paid');
await refused('second payment in the same period', () => agent.payMandate(id, mandate.id, '25'), /already paid/);
const [receipt] = await step('Agent lists its receipts', () => agent.receipts());
check(receipt?.amount === '25', 'the payment carries a receipt');
const record = await step('Agent proves the receipt (amount disclosed)', () => agent.proveReceipt(receipt.id, { discloseAmount: true }).then((r) => r.proof.amount));
check(await agent.verifyReceipt(await agent.proveReceipt(receipt.id, { discloseAmount: true })), 'the receipt verifies on-chain');
const forOwner = await step('Agent proves the receipt for the Owner (0x address as verifier)', () => agent.proveReceipt(receipt.id, { verifier: account.address }));
check(await agent.verifyReceipt(forOwner, { expectedVerifier: account.address }), 'it verifies for the Owner');
await refused('the same receipt checked by someone else', () => agent.verifyReceipt(forOwner, { expectedVerifier: '0x000000000000000000000000000000000000dEaD' }), /made out to verifier/);
const ownerLink = (amount) => paymentLink(site, { to: ownerZk, amount, memo: 'e2e invoice', network: 'testnet' }).toString();
check((await step("Agent pays the Owner's 3 tUSDG link from its balance", () => agent.payLink(ownerLink('3')))).confirmed, 'link paid');
check((await step('Agent pays an open-amount link from the treasury (5)', () => agent.payLink(ownerLink(''), { amount: '5', treasury: id }))).confirmed, 'link paid from the treasury');
const asking = await step('Agent creates a link asking for 4', () => agent.requestLink({ amount: '4', memo: 'agent invoice' }));
const before = Number((await agent.balance()).usdg);
const want = agent.readLink(asking).amount; // 4 plus a few millionths: this link's own amount
check(Number(want) > 4 && Number(want) < 4.001, `the link asks for a unique amount (${want})`);
const waiting = agent.waitForPayment({ amount: want, timeoutSeconds: 180 });
await step("Owner pays the agent's link", () => { const r = readPaymentLink(new URL(asking).searchParams); return owner.send({ amount: BigInt(Math.round(Number(r.amount) * 1e6)), to: parseZkAddress(r.to) }); });
const arrived = await step('Agent was waiting for it', () => waiting);
check(arrived.received && arrived.amount === want && arrived.kind === 'private payment', "the wait returned this link's payment");
check(Math.abs(Number((await agent.balance()).usdg) - before - Number(want)) < 1e-9, 'the agent received exactly the link amount');
const got = await step('Agent lists incoming payments', () => agent.incoming().then((list) => list.map((p) => `${p.amount} ${p.kind}`)));
check(got.includes(`${want} private payment`) && got.includes('800 private payment') && got.includes('25 mandate payment (has a receipt)'), 'payments from others are listed');
check(got.length === 3, 'its own change and self-transfers are not');
check((await step('Agent waits 3 s for 999 that never comes', () => agent.waitForPayment({ amount: '999', timeoutSeconds: 3 }))).received === false, 'the wait times out');
await refused('600 above the agent limit', () => agent.pay(id, { to: ownerZk, amount: '600' }), /above this agent's limit/);
// A-1: a deposit in screening can be taken back by its sender, so it is never "received".
const { abis } = await import('../../src/lib/chain/config.js');
const holding = agent.waitForPayment({ amount: '7', timeoutSeconds: 45 }); // started before the deposit, like a real wait
await step('Owner deposits 7 to the agent (stays in screening)', () => owner.deposit(deployment.usdg, 7_000000n, parseZkAddress(agent.address)));
const held = await step('Agent was waiting for 7', () => holding);
check(held.received === false && held.pending === true, 'the screened deposit is reported as pending, not received');
await step('Owner takes it back (refundToOrigin)', async () => {
  const depositId = (await publicClient.readContract({ address: deployment.pool, abi: abis.pool, functionName: 'depositCount' })) - 1n;
  const hash = await walletClient.writeContract({ address: deployment.pool, abi: abis.pool, functionName: 'refundToOrigin', args: [depositId] });
  return (await publicClient.waitForTransactionReceipt({ hash })).status;
});
check(!(await agent.incoming()).some((p) => p.amount === '7') && !(await agent.incoming({ pending: true })).some((p) => p.amount === '7'), 'the refunded deposit is neither received nor pending');
check((await agent.waitForPayment({ amount: '7', timeoutSeconds: 3 })).pending !== true, 'and no longer reported at all');
// Combine: many received notes, one payment that needs three of them.
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const seed2 = newSeed();
  const payee = await createAgent({ seed: seed2, network: 'testnet', api: site, rpc: RPC, stateDir: mkdtempSync(join(tmpdir(), 'zkd-a2-')) });
  await step('Owner pays a second agent six times 80 tUSDG', async () => {
    for (let i = 0; i < 6; i++) await owner.send({ amount: 80_000000n, to: parseZkAddress(payee.address) });
  });
  const before = await payee.balance();
  check(before.notes === 6 && before.usdg === '480', `six notes, 480 tUSDG (${before.notes} notes)`);
  await refused('a payment needing three notes', () => payee.send({ to: ownerZk, amount: '200' }), /Call zkdesk_combine first/);
  const capped = await createAgent({ seed: seed2, network: 'testnet', api: site, rpc: RPC, maxPerDay: '100', stateDir: mkdtempSync(join(tmpdir(), 'zkd-a3-')) });
  await refused('combine past the daily limit', () => capped.combine(), /per 24 hours/);
  check((await payee.balance()).notes === 6, 'nothing was merged');
  await refused('a target combining cannot reach', () => payee.combine({ target: '470' }), /would not reach 470 USDG after fees. Nothing was merged/);
  const merged = await step('Second agent combines its notes', () => payee.combine());
  check(merged.merges === 5 && merged.notes === 1, `5 merges into one note of ${merged.largestNote}`);
  check(merged.reached === true && Math.abs(Number(merged.spentLast24h) - Number(merged.feesAbout)) < 1e-6, `the daily record holds only the merge fees (${merged.spentLast24h}); the refused payment was released`);
  check((await step('...and now sends 200', () => payee.send({ to: ownerZk, amount: '200' }))).confirmed, 'the payment goes through');
}
// v3.4: the Owner scopes the agent (the Owner's zkd: and 0x addresses, at most 30 tUSDG a day).
{
  const { buildLedger, ACTIONS } = await import('../../src/lib/zk/ledger.js');
  const limits = async () => (await agent.treasuries()).find((t) => t.id === id).payerLimits;
  await step('Owner scopes the agent: two listed recipients, 30 tUSDG a day', () => owner.updateLedger(L(), { scope: { allowTo: [parseZkAddress(ownerZk), account.address], budget: 30_000000n, budgetPeriod: 86_400n } }));
  const lim = await step('Agent sees its limits', limits);
  check(lim.budget === '30' && lim.budgetPeriod === 'day' && lim.allowedRecipients.length === 2 && lim.spentThisPeriod === '0', 'the limits, as the agent reads them');
  check((await step('Agent pays the Owner 20 (listed, within the budget)', () => agent.pay(id, { to: ownerZk, amount: '20' }))).confirmed, 'paid');
  check((await step('Agent pays 5 to the listed 0x address', () => agent.pay(id, { to: account.address, amount: '5' }))).confirmed, 'unshielded to the listed address');
  check((await limits()).spentThisPeriod === '25' && (await limits()).leftThisPeriod === '5', 'the agent has spent 25 of 30 today');
  await refused('over the daily budget (25 + 10 > 30)', () => agent.pay(id, { to: ownerZk, amount: '10' }), /over the treasury budget/);
  await refused('a recipient not on the list', () => agent.pay(id, { to: agent.address, amount: '1' }), /not on the treasury's list/);
  // The SDK's checks off: the prover itself cannot make either proof, so the chain never sees one.
  {
    await owner.sync();
    const T = owner.ledgers().find((l) => l.owner === ledgerId);
    const k = agentKeys(agentSeed, chain.id);
    const notes = owner.ledgerNotes(T).filter((n) => n.status === 'unspent' && n.asset === BigInt(deployment.usdg)).sort((a, b) => (b.amount > a.amount ? 1 : -1));
    const t = (await publicClient.getBlock()).timestamp;
    const draft = (to, amount) => buildLedger({ tree: owner.state.tree, ledger: T, sk: k.sk, role: 'Payer', action: ACTIONS.transfer, asset: BigInt(deployment.usdg), inputs: [notes[0]], out: { amount, owner: to }, ext: { recipient: '0x0000000000000000000000000000000000000000', extAmount: 0n, encryptedOutput1: '0x', encryptedOutput2: '0x' }, t, check: false });
    await refused('a proof over the budget', () => prove('ledger', draft(keys.owner, 10_000000n).witness), /./);
    await refused('a proof to an off-list recipient', () => prove('ledger', draft(k.owner, 1_000000n).witness), /./);
    check((await step('...while a listed payment within the budget still proves', () => prove('ledger', draft(keys.owner, 5_000000n).witness).then(() => 'proved'))) === 'proved', 'the same draft proves when it is within the scope');
  }
  const big = await step('Agent pays 60 to itself (off the list, above the approval line)', () => agent.pay(id, { to: agent.address, amount: '60' }));
  check(big.requested === true, 'it became a request for the Owner');
  // The watcher now reports what happened since its first check.
  await step('Watcher checks again', async () => (await watchOnce()).trim().split('\n').length);
  const texts = hooks.map((h) => `${h.event}: ${h.text}`);
  console.log(texts.map((t) => `    ${t.split('\n')[0]}`).join('\n'));
  check(texts.some((t) => /^payment: Agent treasury: Your agent paid 20 USDG to zkd:/.test(t)), 'an alert for the agent paying 20');
  check(texts.some((t) => /^payment: Agent treasury: A payment you approved \(requested by your agent\) was sent: 80 USDG/.test(t)), 'an alert for the approved 80 the agent asked for');
  check(texts.some((t) => /^approval: .*approval requested: 60 USDG/.test(t)), 'an alert for the approval it asked for');
  check(texts.some((t) => /^budget: .*83% of its budget/.test(t)), 'an alert at 80% of the budget (25 of 30)');
  check(texts.some((t) => /^limits: /.test(t)), 'an alert for the limits the Owner set');
  const count = hooks.length;
  await step('Watcher checks a third time', async () => (await watchOnce()).trim().split('\n').length);
  check(hooks.length === count, 'nothing is sent twice');
  await step('Owner approves it', async () => {
    await owner.sync();
    const r = (await owner.ledgerRequests(L())).find((x) => x.status === 'Awaiting Owner');
    return owner.approveRequest(L(), r).then(() => r.id);
  });
  const ok = (await agent.requests(id)).find((r) => r.status === 'Approved' && r.mine);
  check((await step('Agent completes the approved payment', () => agent.complete(id, ok.id))).confirmed, 'an Owner-approved payment is outside the scope');
  check((await limits()).spentThisPeriod === '25', 'and does not count toward the budget');
  // 3.22: the per-payment limit. The Owner declines a request; an agent set not to ask refuses itself.
  check((await agent.treasuries()).find((t) => t.id === id).perPaymentLimit === '50', 'the agent reads its per-payment limit');
  const dayBefore = (await agent.balance()).spentLast24h;
  check((await step('Agent asks for 70', () => agent.pay(id, { to: agent.address, amount: '70' }))).requested === true, 'a request');
  check((await agent.balance()).spentLast24h === dayBefore, 'a request does not use up the daily limit');
  await step('Owner declines it', async () => {
    await owner.sync();
    const r = (await owner.ledgerRequests(L())).find((x) => x.status === 'Awaiting Owner');
    await owner.declineRequest(L(), r);
    return r.id;
  });
  const no = (await agent.requests(id)).find((r) => r.amount === '70');
  check(no?.status === 'Declined', 'the agent sees it declined');
  await refused('completing a declined request', () => agent.complete(id, no.id), /is Declined, not Approved/);
  const quiet = await createAgent({ seed: agentSeed, network: 'testnet', api: site, rpc: RPC, maxPerTx: '500', askApproval: false, stateDir: mkdtemp(pjoin(tmp(), 'zkd-a4-')) });
  await refused('a payment above the limit by an agent set not to ask', () => quiet.pay(id, { to: ownerZk, amount: '51' }), /per-payment limit of 50 USDG.*not to ask/);
  // v3.18: the spending report attributes each payment from the chain and names its recipient.
  const report = await step('Agent reads its spending report', () => agent.spending(id, { all: true }));
  const mine = report.payments.filter((p) => p.by === 'payer');
  check(report.spentThisPeriod === '25' && report.budget === '30', 'the period total and budget');
  check(mine.some((p) => p.amount === '20' && p.to === ownerZk && p.toSource === 'chain'), "the 20 to the Owner's zkd: (proven against the payment's commitment)");
  check(mine.some((p) => p.amount === '5' && p.to?.toLowerCase() === account.address.toLowerCase() && p.toSource === 'chain'), 'the 5 unshield to the public address');
  check(report.payments.some((p) => p.by === 'approved by the Owner' && p.amount === '60' && p.to === agent.address), "the approved 60 is not the agent's own");
  check(report.payments.some((p) => p.by === 'mandate' && p.amount === '25'), 'the mandate pull');
  check(!mine.some((p) => p.amount === '60' || p.amount === '80'), "approved payments are never counted as the agent's");
  await step('Owner lifts the scope', () => owner.updateLedger(L(), { scope: { allowTo: [], budget: 0n } }));
  check((await limits()) === null, 'no limits left');
  check((await step('Agent pays itself 1 (no list now)', () => agent.pay(id, { to: agent.address, amount: '1' }))).confirmed, 'paid');

  if (!/127\.0\.0\.1|localhost/.test(RPC ?? '')) console.log('    (the access-end steps need a local fork: they move chain time)');
  else {
    // v3.5: the Owner gives the agent 2 hours of access. After that every Payer payment is refused (also
    // one the Owner approved), by the SDK and by the prover; the Owner extends it and the agent pays again.
    const t0 = (await publicClient.getBlock()).timestamp;
    await step('Owner gives the agent access for 2 hours', async () => { await owner.sync(); return owner.updateLedger(L(), { scope: { allowTo: [], budget: 0n, until: t0 + 7_200n } }); });
    const lim2 = await limits();
    check(lim2?.accessEnds === new Date(Number(t0 + 7_200n) * 1000).toISOString() && lim2.accessEnded === false, 'the agent reads when its access ends');
    check((await step('Agent pays itself 1 within its access', () => agent.pay(id, { to: agent.address, amount: '1' }))).confirmed, 'paid');
    check((await step('Agent asks for 60 (above the approval line)', () => agent.pay(id, { to: agent.address, amount: '60' }))).requested === true, 'a request');
    await step('Owner approves it', async () => {
      await owner.sync();
      const r = (await owner.ledgerRequests(L())).find((x) => x.status === 'Awaiting Owner');
      return owner.approveRequest(L(), r).then(() => r.id);
    });
    await step('Chain time moves 2 hours on', async () => {
      await publicClient.request({ method: 'evm_increaseTime', params: [7_300] });
      await publicClient.request({ method: 'anvil_mine', params: ['0x1'] });
      return String((await publicClient.getBlock()).timestamp - t0);
    });
    await refused('a payment after its access ended', () => agent.pay(id, { to: agent.address, amount: '1' }), /This agent's access to treasury 0x[0-9a-f]+ ended/);
    await refused('a mandate payment after its access ended', () => agent.payMandate(id, mandate.id, '25'), /This agent's access to treasury 0x[0-9a-f]+ ended/);
    const late = (await agent.requests(id)).find((r) => r.status === 'Approved' && r.mine);
    await refused('the approved payment after its access ended', () => agent.complete(id, late.id), /This agent's access to treasury 0x[0-9a-f]+ ended/);
    {
      await owner.sync();
      const T = owner.ledgers().find((l) => l.owner === ledgerId);
      const k = agentKeys(agentSeed, chain.id);
      const [note] = owner.ledgerNotes(T).filter((n) => n.status === 'unspent' && n.asset === BigInt(deployment.usdg)).sort((a, b) => (b.amount > a.amount ? 1 : -1));
      const draft = (t) => buildLedger({ tree: owner.state.tree, ledger: T, sk: k.sk, role: 'Payer', action: ACTIONS.transfer, asset: BigInt(deployment.usdg), inputs: [note], out: { amount: 1_000000n, owner: keys.owner }, ext: { recipient: '0x0000000000000000000000000000000000000000', extAmount: 0n, encryptedOutput1: '0x', encryptedOutput2: '0x' }, t, check: false });
      const now = (await publicClient.getBlock()).timestamp;
      await refused('a proof at chain time (after the end)', () => prove('ledger', draft(now).witness), /./);
      check((await step('...while the same payment dated before the end still proves', () => prove('ledger', draft(t0 + 7_000n).witness).then(() => 'proved'))) === 'proved', 'only the time decides (the chain takes such a proof for at most an hour after its time)');
    }
    const before = hooks.length;
    await step('Watcher checks after the end', async () => (await watchOnce()).trim().split('\n').length);
    const ended = hooks.slice(before).map((h) => `${h.event}: ${h.text}`);
    console.log(ended.map((t) => `    ${t.split('\n')[0]}`).join('\n'));
    check(ended.some((t) => /^access: Agent treasury: the agent's access ended at .* none after\./.test(t)), 'an alert that the access ended');
    check(ended.some((t) => /^limits: .*agent's access end changed/.test(t)), 'an alert for the new access end');
    await step('Owner extends the access by 7 days', async () => { await owner.sync(); return owner.updateLedger(L(), { scope: { allowTo: [], budget: 0n, until: (await publicClient.getBlock()).timestamp + 7n * 86_400n } }); });
    check((await limits()).accessEnded === false, 'access again');
    check((await step('Agent pays itself 1 again', () => agent.pay(id, { to: agent.address, amount: '1' }))).confirmed, 'paid after the extension');
  }
}
hookServer.close();
console.log(`Agent balance now ${(await agent.balance()).usdg} tUSDG. Agent e2e passed. (${record})`);
process.exit(0);
