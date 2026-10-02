import { apiBase } from '../chain/config.js';
// Browser transports to the ZKDesk services (same origin). Used by the account worker and the adapter.

/** POST a proof to /api/relay and follow it to a final status (GET without a body: relayer info). */
export async function relay(body) {
  if (!body) return (await fetch(`${apiBase}/relay`)).json();
  let r = await (await fetch(`${apiBase}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const { voucher } = r; // only in the first answer; usable once the transfer confirms
  for (let i = 0; i < 30 && (r.status === 'submitted' || r.status === 'queued'); i++) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await (await fetch(`${apiBase}/ops/${r.opId}`)).json();
  }
  return { ...r, voucher };
}

/** Approval requests mailbox (api/requests.js): sealed ciphertexts only treasury members can open. */
export const mailbox = {
  list: async (ledger) => (await (await fetch(`${apiBase}/requests?ledger=${ledger}`)).json()).requests ?? [],
  post: async (ledgerId, ciphertext, signature) => (await fetch(`${apiBase}/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ledgerId, ciphertext, signature }) })).json(),
};
