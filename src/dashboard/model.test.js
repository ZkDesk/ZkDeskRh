import assert from 'node:assert/strict';
import { applyAction, csvCell, distributionPercentages, initialState, receiptDisclosure, totals, validateAction } from './model.js';

// Money must remain consistent as capital moves through credit and treasury.
let state = initialState();
assert.deepEqual(totals(state), { collateral: 50000, debt: 18000, assets: 250000 });
for (const [asset, limit] of [['SPY', 6000], ['QQQ', 6000], ['NVDA', 4500], ['TSLA', 4500]]) {
  assert.equal(Object.keys(validateAction(state, 'open', { asset, collateral: 10000, amount: limit })).length, 0);
  assert.ok(validateAction(state, 'open', { asset, collateral: 10000, amount: limit + 0.01 }).amount);
}
state = applyAction(state, 'open', { asset: 'NVDA', collateral: 10000, amount: 4500 });
assert.equal(state.cash, 124500);
assert.equal(totals(state).debt, 22500);
const positionId = state.positions.at(-1).id;
state = applyAction(state, 'repay', { id: positionId, amount: 500 });
assert.equal(state.cash, 124000);
assert.equal(state.positions.at(-1).debt, 4000);
state = applyAction(state, 'add', { id: positionId, amount: 5000 });
assert.equal(state.positions.at(-1).collateral, 15000);
state = applyAction(state, 'close', { id: positionId });
assert.equal(state.cash, 120000);
assert.equal(state.freeStock, 15000);
assert.equal(state.positions.length, 1);
const gross = totals(state).assets;
state = applyAction(state, 'allocate', { amount: 10000 });
assert.equal(state.cash, 110000);
assert.equal(state.vault, 90000);
assert.equal(totals(state).assets, gross);
state = applyAction(state, 'deallocate', { amount: 10000 });
assert.equal(state.cash, 120000);
assert.equal(totals(state).assets, gross);
assert.ok(validateAction(state, 'allocate', { amount: 120001 }).amount);
assert.ok(validateAction(state, 'deallocate', { amount: 80001 }).amount);
for (const amount of [0, -1, 0.001, Infinity, NaN, 1000000001]) assert.ok(validateAction(state, 'deposit', { amount }).amount);

// Authorization is enforced in the model as well as by disabled controls.
assert.ok(validateAction({ ...state, role: 'Auditor' }, 'deposit', { amount: 10 }).general);
assert.ok(validateAction({ ...state, role: 'Payer' }, 'open', { asset: 'SPY', collateral: 100, amount: 10 }).general);
assert.equal(Object.keys(validateAction({ ...state, role: 'Payer' }, 'pay', { id: state.mandates[0].id, amount: 100 })).length, 0);
assert.ok(validateAction({ ...state, role: 'Auditor' }, 'pay', { id: state.mandates[0].id, amount: 100 }).general);

// Mandates cannot exceed their cap, available funds, or one execution per period.
const payrollId = state.mandates[0].id;
assert.ok(validateAction(state, 'pay', { id: payrollId, amount: 4201 }).amount);
assert.ok(validateAction({ ...state, cash: 10 }, 'pay', { id: payrollId, amount: 100 }).amount);
state = applyAction(state, 'pay', { id: payrollId, amount: 4200 });
assert.equal(state.cash, 115800);
assert.ok(state.activity[0].receipt);
assert.ok(validateAction(state, 'pay', { id: payrollId, amount: 1 }).general);
const invoiceId = state.mandates[1].id;
state = applyAction(state, 'pause', { id: invoiceId });
assert.ok(validateAction(state, 'pay', { id: invoiceId, amount: 1 }).general);
state = applyAction(state, 'resume', { id: invoiceId });
state = applyAction(state, 'pay', { id: invoiceId, amount: 860 });
assert.equal(state.mandates[1].status, 'Complete');
assert.ok(validateAction(state, 'resume', { id: invoiceId }).general);
state = applyAction(state, 'revoke', { id: payrollId });
assert.ok(validateAction(state, 'resume', { id: payrollId }).general);
const invalid = validateAction(state, 'mandate', { kind: 'Invoice', recipient: 'A', cap: -1, period: 'One-time', expiry: 'not-a-date', reference: '' });
for (const key of ['recipient', 'cap', 'expiry', 'reference']) assert.ok(invalid[key]);
// Receipt disclosure is an allowlist: raw titles/details must never leak excluded data.
const receipt = { id: 'activity-demo', receipt: 'DEMO-RECEIPT', at: '2026-09-26T10:00:00Z', period: '2026-09', amount: 4321, recipient: 'Private recipient', title: 'Payment to Private recipient', detail: 'Paid 4321 to Private recipient', privateExtra: 'Not exported' };
const omitted = receiptDisclosure(receipt);
assert.equal('amount' in omitted, false);
assert.equal('recipient' in omitted, false);
assert.equal('detail' in omitted, false);
assert.equal('privateExtra' in omitted, false);
assert.equal(JSON.stringify(omitted).includes('Private recipient'), false);
assert.equal(JSON.stringify(omitted).includes('4321'), false);
const amountOnly = receiptDisclosure(receipt, { includeAmount: true });
assert.equal(amountOnly.amount, 4321);
assert.equal('recipient' in amountOnly, false);
const recipientOnly = receiptDisclosure(receipt, { includeRecipient: true });
assert.equal(recipientOnly.recipient, 'Private recipient');
assert.equal('amount' in recipientOnly, false);
const masked = receiptDisclosure(receipt, { includeAmount: true, includeRecipient: true, masked: true });
assert.equal('amount' in masked, false);
assert.equal(masked.disclosure.amountIncluded, false);
assert.equal(masked.recipient, 'Private recipient');
assert.deepEqual(distributionPercentages([123750, 81000, 60000]), [47, 30, 23]);
assert.deepEqual(distributionPercentages([1, 1, 1]), [34, 33, 33]);
assert.deepEqual(distributionPercentages([0, 0, 0]), [0, 0, 0]);
assert.deepEqual(distributionPercentages([0, 1, 0]), [0, 100, 0]);
// The spending report's CSV export: quoted, quotes doubled, formulas neutralized.
assert.equal(csvCell('a"b'), '"a""b"');
assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
assert.equal(csvCell('+1'), `"'+1"`);
assert.equal(csvCell('-0.5'), `"'-0.5"`);
assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
assert.equal(csvCell(null), '""');
assert.equal(csvCell('zkd:0a'), '"zkd:0a"');
console.log('Dashboard model checks passed: accounting, role authorization, mandate bounds, invalid inputs, and selective receipt disclosure.');
