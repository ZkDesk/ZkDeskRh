// Payment request links ("Request payment" in the dashboard; agents create and pay them too):
// /dashboard?view=treasury&pay=zkd:…&amount=…&memo=…&network=…  Nothing is posted anywhere: the link
// carries the recipient's private address, an optional amount and an optional note. No imports, so the
// demo bundle can use it.
const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;

/** The link for `to` (a zkd: address) on `network`, at `origin` (e.g. https://zkdesk.tech). */
export function paymentLink(origin, { to, amount = '', memo = '', network }) {
  const url = new URL('/dashboard', origin);
  url.searchParams.set('view', 'treasury');
  url.searchParams.set('pay', to);
  if (amount) url.searchParams.set('amount', amount);
  if (memo) url.searchParams.set('memo', memo.slice(0, 60));
  url.searchParams.set('network', network);
  return url;
}

/** What a link's query asks for: { to, amount ('' = the payer chooses), memo, network | null }, or null. */
export function readPaymentLink(params) {
  const to = params.get('pay')?.trim() ?? '';
  if (!/^zkd:[0-9a-f]{128}$/i.test(to)) return null;
  const amount = AMOUNT.test(params.get('amount') ?? '') && Number(params.get('amount')) > 0 ? params.get('amount') : '';
  return { to, amount, memo: (params.get('memo') ?? '').slice(0, 60), network: params.get('network') };
}
