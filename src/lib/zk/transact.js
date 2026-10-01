// Builds inputs for circuits/transact. Pure: no keys leave the caller.
import { encodeAbiParameters, keccak256, zeroAddress } from 'viem';
import { FIELD, MAX_AMOUNT, MAX_DEPTH, noteCommitment, nullifier, nullifierKey, ownerPk, publicAmount, randomField } from './notes.js';

// Must match ZKDeskPool.ExtData field order.
const EXT_DATA = [{ type: 'tuple', components: [
  { name: 'recipient', type: 'address' }, { name: 'extAmount', type: 'int256' }, { name: 'relayer', type: 'address' },
  { name: 'fee', type: 'uint256' }, { name: 'converter', type: 'address' },
  { name: 'encryptedOutput1', type: 'bytes' }, { name: 'encryptedOutput2', type: 'bytes' },
] }];
export const extDataHash = (ext) => BigInt(keccak256(encodeAbiParameters(EXT_DATA, [{ converter: zeroAddress, ...ext }]))) % FIELD;

export const pad = (items, n, fill) => [...items, ...Array.from({ length: n - items.length }, fill)];
const str = (x) => x.toString();

/** Merkle paths for up to two input notes (zero-amount inputs are dummies). */
export function inputPaths(tree, ins) {
  return ins.map((n) => {
    if (n.amount === 0n) return { depth: 0, index: 0n, siblings: Array(MAX_DEPTH).fill(0n) };
    const p = tree.generateProof(n.leafIndex);
    if (p.siblings.length > MAX_DEPTH) throw new Error('Tree deeper than circuit.');
    return { depth: p.siblings.length, index: BigInt(p.index), siblings: pad(p.siblings, MAX_DEPTH, () => 0n) };
  });
}

/** Pads to two inputs with zero-amount dummies; `dummies` reproduces their blindings (same nullifiers). */
export const padInputs = (inputs, dummies = []) => [...inputs, ...Array.from({ length: 2 - inputs.length }, (_, i) => ({ amount: 0n, blinding: dummies[i] ?? randomField() }))];

/**
 * tree: LeanIMT of commitments (bigint). inputs: [{amount, blinding, leafIndex}] (≤2) in `asset`.
 * outputs: [{amount, owner, blinding?}] (≤2); output 1 is in `outAsset` (default: asset).
 * Same asset: Σout − Σin = extAmount − fee. Convert: out0 = Σin + extAmount − fee, out1 = publicAmountOut.
 */
export function buildTransact({ tree, sk, asset, outAsset = asset, publicAmountOut = 0n, inputs = [], outputs = [], ext }) {
  if (inputs.length > 2 || outputs.length > 2) throw new Error('At most two inputs and two outputs.');
  const owner = ownerPk(sk);
  const nk = nullifierKey(sk);
  const ins = padInputs(inputs);
  const outs = pad(outputs, 2, () => ({ amount: 0n, owner, blinding: randomField() })).map((o) => ({ ...o, blinding: o.blinding ?? randomField() }));
  for (const n of [...ins, ...outs]) if (n.amount < 0n || n.amount > MAX_AMOUNT) throw new Error('Amount out of range.');
  const value = ext.extAmount - BigInt(ext.fee);
  const sumIn = ins.reduce((s, n) => s + n.amount, 0n);
  const convert = outAsset !== asset;
  if (convert ? sumIn + value !== outs[0].amount || outs[1].amount !== publicAmountOut : sumIn + value !== outs[0].amount + outs[1].amount || publicAmountOut !== 0n) {
    throw new Error('Inputs, outputs and external amount do not balance.');
  }

  const root = tree.size ? tree.root : 0n;
  const paths = inputPaths(tree, ins);
  const inputNullifiers = ins.map((n) => nullifier(noteCommitment({ asset, amount: n.amount, owner, blinding: n.blinding }), nk));
  const outAssets = [asset, outAsset];
  const outputCommitments = outs.map((o, i) => noteCommitment({ asset: outAssets[i], ...o }));
  const pub = { root, publicAmount: publicAmount(value), extDataHash: extDataHash(ext), asset, outAsset, publicAmountOut, inputNullifiers, outputCommitments };

  const witness = {
    root: str(root), public_amount: str(pub.publicAmount), ext_data_hash: str(pub.extDataHash), asset: str(asset),
    out_asset: str(outAsset), public_amount_out: str(publicAmountOut),
    input_nullifiers: inputNullifiers.map(str), output_commitments: outputCommitments.map(str),
    sk: str(sk), in_amounts: ins.map((n) => str(n.amount)), in_blindings: ins.map((n) => str(n.blinding)),
    in_path_depths: paths.map((p) => p.depth), in_path_indices: paths.map((p) => str(p.index)),
    in_path_siblings: paths.map((p) => p.siblings.map(str)),
    out_amounts: outs.map((o) => str(o.amount)), out_owners: outs.map((o) => str(o.owner)), out_blindings: outs.map((o) => str(o.blinding)),
  };
  return { witness, public: pub, outputs: outs.map((o, i) => ({ ...o, asset: outAssets[i], commitment: outputCommitments[i] })) };
}
