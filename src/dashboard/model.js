export const STORAGE_KEY = 'zkdesk-demo-workspace-v1';
export const VIEWS = ['overview', 'credit', 'treasury', 'payments', 'activity', 'settings'];
export const ROLES = ['Owner', 'Treasurer', 'Payer', 'Auditor'];
export const LTV = { SPY: 0.6, QQQ: 0.6, NVDA: 0.45, TSLA: 0.45 };
export const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
export const positive = (value) => Number.isFinite(Number(value)) && Number(value) >= 0.01 && Number(value) <= 1000000000;
export const today = () => new Date().toISOString().slice(0, 10);
export const futureDate = (days = 30) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
export const can = (role, area) => area === 'payments' ? ['Owner', 'Treasurer', 'Payer'].includes(role) : ['Owner', 'Treasurer'].includes(role);
export const totals = (state) => ({
  collateral: round(state.positions.reduce((sum, item) => sum + item.collateral, 0)),
  debt: round(state.positions.reduce((sum, item) => sum + item.debt, 0)),
  assets: round(state.cash + state.vault + state.freeStock + state.positions.reduce((sum, item) => sum + item.collateral, 0)),
});
export function distributionPercentages(values) {
  const amounts = values.map((value) => Number.isFinite(value) ? Math.max(0, value) : 0);
  const total = amounts.reduce((sum, value) => sum + value, 0);
  if (!total) return amounts.map(() => 0);
  const precise = amounts.map((value) => value / total * 100);
  const result = precise.map(Math.floor);
  const remaining = 100 - result.reduce((sum, value) => sum + value, 0);
  const ranked = precise.map((value, index) => ({ index, fraction: value - result[index] })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < remaining; index++) result[ranked[index].index]++;
  return result;
}
export const periodKey = (mandate, now = new Date()) => mandate.period === 'Monthly' ? now.toISOString().slice(0, 7)
  : mandate.period === 'Weekly' ? `week-${Math.floor(now.getTime() / 604800000)}` : 'once';
export const payable = (mandate) => mandate.status === 'Active' && mandate.expiry >= today() && mandate.paidPeriod !== periodKey(mandate);

export function receiptDisclosure(record, { includeAmount = false, includeRecipient = false, masked = false } = {}) {
  const amountIncluded = Boolean(includeAmount && !masked);
  return {
    id: record.id,
    receipt: record.receipt,
    title: 'Demonstration payment receipt',
    kind: 'Payments',
    at: record.at,
    period: record.period,
    disclosure: { amountIncluded, recipientIncluded: Boolean(includeRecipient) },
    ...(amountIncluded ? { amount: record.amount, asset: 'USDG' } : {}),
    ...(includeRecipient ? { recipient: record.recipient } : {}),
  };
}

export function initialState() {
  return {
    version: 1, cash: 120000, vault: 80000, freeStock: 0, role: 'Owner', masked: false,
    positions: [{ id: 'position-sample', asset: 'SPY', collateral: 50000, debt: 18000, created: today() }],
    mandates: [
      { id: 'mandate-sample-1', kind: 'Payroll', recipient: 'Sample operations team', cap: 4200, period: 'Monthly', expiry: futureDate(180), status: 'Active', paidPeriod: null },
      { id: 'mandate-sample-2', kind: 'Invoice', recipient: 'Sample service provider', cap: 860, period: 'One-time', expiry: futureDate(45), reference: 'DEMO-001', status: 'Active', paidPeriod: null },
    ],
    activity: [{ id: 'activity-opening', kind: 'Treasury', title: 'Sample workspace opened', amount: 250000, at: new Date().toISOString(), detail: 'Opening sample balances: 120,000 USDG liquid, 80,000 allocated, and 50,000 in stock collateral.' }],
  };
}

export function loadState() {
  try {
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (state?.version === 1 && [state.cash, state.vault, state.freeStock].every((n) => Number.isFinite(n) && n >= 0) && Array.isArray(state.positions) && Array.isArray(state.mandates) && Array.isArray(state.activity) && ROLES.includes(state.role)) return state;
  } catch { /* A fresh demo is safer than an unreadable saved workspace. */ }
  return initialState();
}

export function validateAction(state, type, values) {
  const errors = {};
  const area = ['mandate', 'pay', 'pause', 'resume', 'revoke'].includes(type) ? 'payments' : 'treasury';
  if (!can(state.role, area)) errors.general = `${state.role} is a view-only role for this action. Switch to an authorized demo role in Settings.`;
  if (type === 'open') {
    if (!LTV[values.asset]) errors.asset = 'Choose a supported sample collateral asset.';
    if (!positive(values.collateral)) errors.collateral = 'Enter a collateral value greater than zero.';
    if (!positive(values.amount)) errors.amount = 'Enter an amount greater than zero.';
    if (positive(values.collateral) && positive(values.amount) && Number(values.amount) > round(Number(values.collateral) * LTV[values.asset])) errors.amount = `This asset allows up to ${LTV[values.asset] * 100}% opening LTV in the specification.`;
  } else if (['deposit', 'allocate', 'deallocate', 'repay', 'add', 'pay'].includes(type)) {
    if (!positive(values.amount)) errors.amount = 'Enter an amount greater than zero.';
    if (['allocate', 'repay', 'pay'].includes(type) && Number(values.amount) > state.cash) errors.amount = 'There is not enough liquid USDG in this demo workspace.';
    if (type === 'deallocate' && Number(values.amount) > state.vault) errors.amount = 'Enter an amount within the allocated balance.';
  }
  if (['repay', 'add', 'close'].includes(type)) {
    const position = state.positions.find((item) => item.id === values.id);
    if (!position) errors.general = 'This position is no longer available.';
    else {
      if (type === 'repay' && Number(values.amount) > position.debt) errors.amount = 'The repayment cannot exceed the outstanding credit.';
      if (type === 'close' && position.debt > state.cash) errors.general = 'Add enough liquid USDG to repay the outstanding credit before closing.';
    }
  }
  if (type === 'mandate') {
    if (!['Payroll', 'Invoice'].includes(values.kind)) errors.kind = 'Choose payroll or invoice.';
    if (!values.recipient?.trim() || values.recipient.trim().length < 3) errors.recipient = 'Enter a recipient name with at least three characters.';
    if (!positive(values.cap)) errors.cap = 'Enter a payment cap greater than zero.';
    if (!['Monthly', 'Weekly', 'One-time'].includes(values.period)) errors.period = 'Choose a payment period.';
    if (!values.expiry || !/^\d{4}-\d{2}-\d{2}$/.test(values.expiry) || !Number.isFinite(new Date(values.expiry).getTime()) || values.expiry < today()) errors.expiry = 'Choose today or a future expiry date.';
    if (values.kind === 'Invoice' && !values.reference?.trim()) errors.reference = 'Enter an invoice reference.';
  }
  if (['pay', 'pause', 'resume', 'revoke'].includes(type)) {
    const mandate = state.mandates.find((item) => item.id === values.id);
    if (!mandate) errors.general = 'This mandate is no longer available.';
    else if (type === 'pay') {
      if (!payable(mandate)) errors.general = 'This mandate is paused, expired, complete, or already paid for this period.';
      if (Number(values.amount) > mandate.cap) errors.amount = 'This payment exceeds the mandate cap.';
    } else if (['Revoked', 'Complete'].includes(mandate.status)) errors.general = 'This mandate can no longer be changed.';
  }
  return errors;
}

export function applyAction(state, type, values) {
  const errors = validateAction(state, type, values);
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  const next = structuredClone(state);
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const amount = round(values.amount || 0);
  const at = new Date().toISOString();
  let entry;
  if (type === 'open') {
    next.positions.push({ id: `position-${uid}`, asset: values.asset, collateral: round(values.collateral), debt: amount, created: today() });
    next.cash = round(next.cash + amount);
    entry = { kind: 'Credit', title: `${values.asset} credit opened`, amount, detail: `${round(values.collateral)} in sample collateral added. Borrowed USDG credited to the local workspace.` };
  } else if (['repay', 'add', 'close'].includes(type)) {
    const position = next.positions.find((item) => item.id === values.id);
    if (type === 'repay') { position.debt = round(position.debt - amount); next.cash = round(next.cash - amount); }
    if (type === 'add') position.collateral = round(position.collateral + amount);
    if (type === 'close') {
      next.cash = round(next.cash - position.debt);
      next.freeStock = round(next.freeStock + position.collateral);
      next.positions = next.positions.filter((item) => item.id !== position.id);
    }
    entry = { kind: 'Credit', title: `${position.asset} ${type === 'repay' ? 'credit repaid' : type === 'add' ? 'collateral added' : 'position closed'}`, amount: type === 'close' ? position.debt : amount, detail: type === 'close' ? 'Outstanding credit repaid; collateral returned to available sample stock assets.' : type === 'add' ? 'External sample collateral added to this position.' : 'Liquid demo USDG used to reduce outstanding credit.' };
  } else if (['deposit', 'allocate', 'deallocate'].includes(type)) {
    if (type === 'deposit') next.cash = round(next.cash + amount);
    if (type === 'allocate') { next.cash = round(next.cash - amount); next.vault = round(next.vault + amount); }
    if (type === 'deallocate') { next.cash = round(next.cash + amount); next.vault = round(next.vault - amount); }
    entry = { kind: 'Treasury', title: type === 'deposit' ? 'Sample USDG added' : type === 'allocate' ? 'USDG allocated' : 'USDG moved to liquid balance', amount, detail: 'Local demonstration only. No deposit, vault transaction, or blockchain verification occurred.' };
  } else if (type === 'mandate') {
    next.mandates.push({ id: `mandate-${uid}`, kind: values.kind, recipient: values.recipient.trim(), cap: round(values.cap), period: values.kind === 'Invoice' ? 'One-time' : values.period, expiry: values.expiry, reference: values.reference?.trim() || '', status: 'Active', paidPeriod: null });
    entry = { kind: 'Payments', title: `${values.kind} mandate created`, amount: round(values.cap), detail: `Spending permission for ${values.recipient.trim()}. This amount is a cap, not an executed payment.` };
  } else {
    const mandate = next.mandates.find((item) => item.id === values.id);
    if (type === 'pay') {
      next.cash = round(next.cash - amount);
      mandate.paidPeriod = periodKey(mandate);
      if (mandate.period === 'One-time') mandate.status = 'Complete';
      entry = { kind: 'Payments', title: `Payment to ${mandate.recipient}`, amount, recipient: mandate.recipient, receipt: `DEMO-${uid.toUpperCase()}`, period: mandate.paidPeriod, detail: 'Demonstration receipt only. No assets were transferred and no zero-knowledge receipt proof was generated.' };
    } else {
      mandate.status = type === 'pause' ? 'Paused' : type === 'resume' ? 'Active' : 'Revoked';
      entry = { kind: 'Payments', title: `Mandate ${mandate.status.toLowerCase()}`, amount: 0, detail: `${mandate.recipient}: ${mandate.status.toLowerCase()} in this local workspace.` };
    }
  }
  next.activity.unshift({ id: `activity-${uid}`, at, ...entry });
  return next;
}
