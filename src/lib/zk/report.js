// Treasury spending report (v3.18): which payments left a treasury, who made them and to whom, from
// state the client already holds. Pure: the caller supplies the chain reads (calls, times).
import { decryptConfig, decryptNote } from './crypto.js';
import { payerDeltas } from './ledger.js';
import { noteCommitment } from './notes.js';
import { zkAddress } from './keys.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const abs = (x) => (x < 0n ? -x : x);

/**
 * The act() call of a BudgetNote's transaction, only if it is the real ledger call that posted this note:
 * sent to the ledger, for this ledger, spending this note's nonce and writing this accumulator. A contract
 * that calls act() can put decoy arguments in the outer transaction; those are not this call.
 */
export function verifiedCall(call, note, ledgerAddress) {
  if (!call || String(call.to).toLowerCase() !== String(ledgerAddress).toLowerCase()) return null;
  const [p, e] = call.args ?? [];
  if (!p || !e || p.ledgerId !== note.id || p.inputNullifiers?.[0] !== note.nonce || p.budgetNew !== note.commit) return null;
  return { proof: p, ext: e };
}

/**
 * Rows for one treasury, oldest first, without times.
 * ledger: ledgerKeys + {owner, config}. events: its ledger events in chain order. notes: its notes
 * (ledgerNotes). ciphertextsByTx: Map tx -> [{commitment, ciphertext}] in log order. pulls / mandates:
 * its Pulled events and mandates. calls: Map tx -> {to, args} (act() transactions) or null.
 * intentsFrom: Map intent -> requester owner key (from the approval mailbox).
 *
 * by: 'payer' (the current Payer made it on its own: the spending record rose, on-chain), 'former
 * payer' (a Payer since replaced), 'approved' (above the threshold, approved by the Owner), 'member'
 * (Owner or Treasurer), 'mandate', or 'unknown' (the call could not be read). amount: for a Payer row,
 * the rise of the spending record (proven); otherwise the notes spent minus the change.
 * toSource: 'chain' (a public unshield address, or a private recipient whose payment commitment matches:
 * that proves the owner key, toOwner), 'paying app' (recorded, not checked), or null (unknown: a private
 * payment from before 3.18). mismatch: the notes the members can read do not add up (shown as a warning).
 */
export function paymentRows({ ledger, events, notes, ciphertextsByTx, pulls = [], mandates = [], calls, intentsFrom = new Map(), ledgerAddress }) {
  const spentByTx = new Map();
  for (const n of notes) if (n.spentIn) spentByTx.set(n.spentIn, [...(spentByTx.get(n.spentIn) ?? []), n]);
  // changeCommitment: output 1 as the verified call names it. Without one (a mandate pull), the change is
  // the first ciphertext of the transaction that opens as a ledger note.
  const outflow = (tx, changeCommitment) => {
    const spent = spentByTx.get(tx) ?? [];
    let change;
    for (const c of ciphertextsByTx.get(tx) ?? []) {
      if (changeCommitment !== undefined && c.commitment !== changeCommitment) continue;
      const o = decryptNote(c.ciphertext, ledger.encSecret);
      if (o && noteCommitment({ ...o, owner: ledger.owner }) === c.commitment) { change = o; break; }
    }
    const asset = spent[0]?.asset ?? change?.asset;
    return { asset, amount: spent.reduce((t, n) => t + n.amount, 0n) - (change?.amount ?? 0n), memo: change?.memo };
  };

  // Who held the Payer role at each point: the latest config the Owner posted (create, rotate, policy).
  const ownEvents = events.filter((e) => e.id === ledger.owner);
  const payerAt = new Map();
  let payer = null;
  for (const e of ownEvents) {
    if (e.name === 'LedgerConfig') payer = decryptConfig(e.config, ledger.encSecret)?.payer ?? payer;
    if (e.name === 'BudgetNote') payerAt.set(e, payer);
  }
  const currentPayer = ledger.config.payer;

  const rows = [];
  for (const { note, delta } of payerDeltas(ledger.lsk, ownEvents.filter((e) => e.name === 'BudgetNote'))) {
    const call = verifiedCall(calls.get(note.tx), note, ledgerAddress);
    const out = outflow(note.tx, call?.proof.outputCommitments[0]);
    const asset = call ? BigInt(call.proof.asset) : out.asset;
    const unshield = call && call.ext.recipient !== ZERO ? { to: call.ext.recipient, amount: abs(BigInt(call.ext.extAmount)) } : null;
    const noteAmount = out.amount < 0n ? 0n : out.amount;
    // For the Payer's own payment the spending record's rise is the amount that left (proven); a note the
    // other members cannot read can make the note-based amount too low, so it is only cross-checked.
    // For others, at least the public part left (a note only its writer can read can hide the rest).
    const amount = delta > 0n ? delta : noteAmount < (unshield?.amount ?? 0n) ? unshield.amount : noteAmount;
    const privateAmount = amount - (unshield?.amount ?? 0n);
    // A private recipient is proven when the payment note's commitment, rebuilt from the memo, is output 2
    // (it proves the owner key; the encryption-key half of a zkd: address is as recorded).
    const memo = out.memo;
    const proven = call && memo && typeof memo !== 'string' && privateAmount > 0n
      && noteCommitment({ asset, amount: privateAmount, owner: memo.owner, blinding: memo.blinding }) === call.proof.outputCommitments[1];
    const privateTo = memo ? (typeof memo === 'string' ? memo : zkAddress(memo)) : null;
    // A pure unshield is complete only if output 2 is the ledger's own empty note. For the Payer the
    // record's delta settles it; for a member, a note the others cannot read could hide a private part.
    const emptyOut2 = () => (ciphertextsByTx.get(note.tx) ?? []).some((c) => {
      if (c.commitment !== call.proof.outputCommitments[1]) return false;
      const o = decryptNote(c.ciphertext, ledger.encSecret);
      return o && o.amount === 0n && noteCommitment({ ...o, owner: ledger.owner }) === c.commitment;
    });
    const hiddenPart = unshield && privateAmount <= 0n && delta === 0n && !emptyOut2();
    let to;
    let toSource;
    if (hiddenPart) [to, toSource] = [`${unshield.to} + a private recipient`, null];
    else if (unshield && privateAmount <= 0n) [to, toSource] = [unshield.to, 'chain'];
    else if (unshield) [to, toSource] = [`${unshield.to} + ${privateTo ?? 'a private recipient'}`, proven ? 'chain' : privateTo ? 'paying app' : null];
    else [to, toSource] = [privateTo, proven ? 'chain' : privateTo ? 'paying app' : null];
    const by = delta > 0n ? (payerAt.get(note) === currentPayer ? 'payer' : 'former payer') : call ? (call.proof.cosignIntent ? 'approved' : 'member') : 'unknown';
    const requestedBy = by === 'approved' ? intentsFrom.get(call.proof.cosignIntent) ?? null : null;
    rows.push({
      tx: note.tx, block: note.block, asset, amount, by, to, toSource, toOwner: proven ? memo.owner : null,
      requestedByPayer: requestedBy !== null && requestedBy === currentPayer,
      // The notes the members can read do not add up to the amount (a note only its writer can read).
      mismatch: delta > 0n ? delta !== noteAmount : hiddenPart || noteAmount < (unshield?.amount ?? 0n),
    });
  }
  for (const p of pulls.filter((x) => x.ledgerId === ledger.owner)) {
    const m = mandates.find((x) => x.commit === p.commit);
    const out = outflow(p.tx);
    rows.push({
      tx: p.tx, block: p.block, asset: out.asset ?? m?.asset, amount: out.amount < 0n ? 0n : out.amount, by: 'mandate',
      to: m ? zkAddress({ owner: m.recipient, encPub: m.recipientEncPub }) : null, toSource: m ? 'chain' : null, toOwner: m?.recipient ?? null, mandate: m?.label ?? '', requestedByPayer: false, mismatch: false,
    });
  }
  return rows.sort((a, b) => Number(a.block - b.block));
}
