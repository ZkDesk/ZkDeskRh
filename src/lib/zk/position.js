// Builds inputs for circuits/position (one private credit transition). Mirrors its constraints so
// invalid steps fail here with a clear message instead of as an unprovable witness.
import { encodeAbiParameters, keccak256 } from 'viem';
import { FIELD, MAX_AMOUNT, noteCommitment, nullifier, nullifierKey, ownerPk, positionCommitment, randomField } from './notes.js';
import { inputPaths, padInputs } from './transact.js';
import { operatorEncrypt } from './grumpkin.js';

export const WAD = 10n ** 18n;
const HEALTH_SCALE = 10n ** 6n;

// Must match CreditDesk.PositionExt field order.
const POSITION_EXT = [{ type: 'tuple', components: [
  { name: 'relayer', type: 'address' }, { name: 'fee', type: 'uint256' },
  { name: 'encryptedOutput1', type: 'bytes' }, { name: 'encryptedOutput2', type: 'bytes' }, { name: 'encryptedPosition', type: 'bytes' },
] }];
export const positionExtHash = (ext) => BigInt(keccak256(encodeAbiParameters(POSITION_EXT, [ext]))) % FIELD;

export const debtOf = (debtScaled, index) => (debtScaled * index + WAD - 1n) / WAD; // ceil
/** USDG value (6 decimals) of 18-decimal collateral at an 8-decimal mark. */
export const valueOf = (collateral, mark) => (collateral * mark) / 10n ** 20n;
/** Largest debt allowed at `ltvBps`. */
export const maxDebt = (collateral, mark, ltvBps) => (collateral * mark * BigInt(ltvBps)) / 10n ** 24n;

const str = (x) => x.toString();

/**
 * old: {collateral, debtScaled, blinding} or null (open). Deltas are bigints in base units.
 * inputs: notes paying collateral (collIn) or USDG (repay). ext: PositionExt.
 */
/** blindings: optional {position, outputs: [b0, b1], operator} to reproduce a draft (ciphertexts are made first). */
/** operatorPk: the desk operator's Grumpkin key [x, y] (CreditDesk.operatorPk). */
export function buildPosition({ tree, sk, collAsset, usdgAsset, mark, ltvBps, rateIndex, operatorPk, old = null, collIn = 0n, collOut = 0n, draw = 0n, repay = 0n, inputs = [], ext, blindings = {} }) {
  if ((collIn && repay) || (draw && collOut)) throw new Error('Combine at most one payment in and one payout per step.');
  for (const v of [collIn, collOut, draw, repay]) if (v < 0n || v > MAX_AMOUNT) throw new Error('Amount out of range.');
  const owner = ownerPk(sk);
  const nk = nullifierKey(sk);
  const inAsset = repay ? usdgAsset : collAsset;
  const ins = padInputs(inputs);
  const sumIn = ins.reduce((s, n) => s + n.amount, 0n);
  const change = sumIn - collIn - repay;
  if (change < 0n) throw new Error('Not enough private balance for this step.');

  const drawScaled = draw ? (draw * WAD + rateIndex - 1n) / rateIndex : 0n;
  const repayScaled = (repay * WAD) / rateIndex;
  const oldColl = old?.collateral ?? 0n;
  const oldDebt = old?.debtScaled ?? 0n;
  const newColl = oldColl + collIn - collOut;
  const newDebtScaled = oldDebt + drawScaled - repayScaled;
  if (newColl < 0n) throw new Error('That is more collateral than the position holds.');
  if (newDebtScaled < 0n) throw new Error('That repays more than the position owes.');
  if ((draw || collOut) && newDebtScaled * rateIndex * HEALTH_SCALE > newColl * mark * BigInt(ltvBps)) {
    throw new Error('This would exceed the loan-to-value limit at the current price.');
  }

  const oldBlinding = old?.blinding ?? 0n;
  const newBlinding = blindings.position ?? randomField();
  const oldLeaf = old ? positionCommitment({ asset: collAsset, collateral: oldColl, debtScaled: oldDebt, owner, blinding: oldBlinding }) : 0n;
  const closed = newColl === 0n && newDebtScaled === 0n;
  const newLeaf = closed ? 0n : positionCommitment({ asset: collAsset, collateral: newColl, debtScaled: newDebtScaled, owner, blinding: newBlinding });
  const outAsset = draw ? usdgAsset : collAsset;
  const outBlindings = blindings.outputs ?? [randomField(), randomField()];
  const outputs = [
    { asset: inAsset, amount: change, owner, blinding: outBlindings[0] },
    { asset: outAsset, amount: draw + collOut, owner, blinding: outBlindings[1] },
  ].map((o) => ({ ...o, commitment: noteCommitment(o) }));
  const inputNullifiers = ins.map((n) => nullifier(noteCommitment({ asset: inAsset, amount: n.amount, owner, blinding: n.blinding }), nk));
  const paths = inputPaths(tree, ins);
  const root = tree.size ? tree.root : 0n;
  const op = operatorEncrypt([newColl, newDebtScaled, owner, newBlinding], operatorPk, blindings.operator);

  const pub = {
    root, extDataHash: positionExtHash(ext), collAsset, usdgAsset, inAsset, mark, ltvBps: BigInt(ltvBps), rateIndex,
    oldLeaf, newLeaf, collIn, collOut, draw, repay, drawScaled, repayScaled, inputNullifiers, outputCommitments: outputs.map((o) => o.commitment),
    operatorPk, operatorEph: op.eph, operatorCipher: op.cipher,
  };
  const witness = {
    root: str(root), ext_data_hash: str(pub.extDataHash), coll_asset: str(collAsset), usdg_asset: str(usdgAsset), in_asset: str(inAsset),
    mark: str(mark), ltv_bps: str(ltvBps), rate_index: str(rateIndex), old_leaf: str(oldLeaf), new_leaf: str(newLeaf),
    coll_in: str(collIn), coll_out: str(collOut), draw: str(draw), repay: str(repay), draw_scaled: str(drawScaled), repay_scaled: str(repayScaled),
    input_nullifiers: inputNullifiers.map(str), output_commitments: pub.outputCommitments.map(str),
    sk: str(sk), old_coll: str(oldColl), old_debt_scaled: str(oldDebt), old_blinding: str(oldBlinding), new_blinding: str(newBlinding),
    in_amounts: ins.map((n) => str(n.amount)), in_blindings: ins.map((n) => str(n.blinding)),
    in_path_depths: paths.map((p) => p.depth), in_path_indices: paths.map((p) => str(p.index)), in_path_siblings: paths.map((p) => p.siblings.map(str)),
    operator_pk: operatorPk.map(str), operator_eph: op.eph.map(str), operator_cipher: op.cipher.map(str),
    out_blindings: outBlindings.map(str), change: str(change), operator_r: str(op.r),
  };
  const position = closed ? null : { asset: collAsset, collateral: newColl, debtScaled: newDebtScaled, blinding: newBlinding };
  return { witness, public: pub, outputs, position, operatorR: op.r };
}
