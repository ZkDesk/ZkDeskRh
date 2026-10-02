import { apiBase } from '../chain/config.js';
// Transports to the ZKDesk services: same origin in the browser (the account worker and the adapter),
// an absolute base such as https://zkdesk.tech/api/mainnet for agents (agent/).

export function createTransport(base) {
  /** POST a proof to /relay and follow it to a final status (GET without a body: relayer info). */
  async function relay(body) {
    if (!body) return (await fetch(`${base}/relay`)).json();
    let r = await (await fetch(`${base}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const { voucher } = r; // only in the first answer; usable once the transfer confirms
    for (let i = 0; i < 30 && (r.status === 'submitted' || r.status === 'queued'); i++) {
      await new Promise((res) => setTimeout(res, 2000));
      r = await (await fetch(`${base}/ops/${r.opId}`)).json();
    }
    return { ...r, voucher };
  }
  /** Approval requests mailbox (api/requests.js): sealed ciphertexts only treasury members can open. */
  const mailbox = {
    list: async (ledger) => (await (await fetch(`${base}/requests?ledger=${ledger}`)).json()).requests ?? [],
    post: async (ledgerId, ciphertext, signature) => (await fetch(`${base}/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ledgerId, ciphertext, signature }) })).json(),
  };
  return { relay, mailbox };
}

export const { relay, mailbox } = createTransport(apiBase);
