// Grumpkin (y^2 = x^3 - 17 over the bn254 scalar field), Noir's embedded curve, and the verifiable
// operator encryption proven in circuits/lib `operator_encrypt`. The desk operator's key opens every
// live position for the epoch health proof and liquidations; owners never need it.
import { poseidon2, poseidon3 } from 'poseidon-lite';
import { FIELD as P, randomField } from './notes.js';

export const DOM_OPERATOR = 0x5a4b442e6f70n; // "ZKD.op"
export const G = [1n, 0x2cf135e7506a45d632d270d45f1181294833fc48d823f272cn];

const mod = (a) => ((a % P) + P) % P;
function inv(a) {
  let [r, x, e] = [1n, mod(a), P - 2n];
  for (; e > 0n; e >>= 1n, x = (x * x) % P) if (e & 1n) r = (r * x) % P;
  return r;
}

// The point at infinity: null inside the arithmetic, (0, 0) outside, as Noir's embedded curve ops
// return it. A position proven with operator_r = 0 has eph = (0, 0) and a (0, 0) shared point.
const isInf = (A) => !A || (A[0] === 0n && A[1] === 0n);

/** Affine point addition. */
function add(A, B) {
  if (isInf(A)) return B;
  if (isInf(B)) return A;
  const [x1, y1] = A;
  const [x2, y2] = B;
  if (x1 === x2 && mod(y1 + y2) === 0n) return null;
  const l = x1 === x2 ? mod(3n * x1 * x1 * inv(2n * y1)) : mod((y2 - y1) * inv(x2 - x1));
  const x3 = mod(l * l - x1 - x2);
  return [x3, mod(l * (x1 - x3) - y1)];
}

export function mul(k, A = G) {
  let R = null;
  for (let Q = A; k > 0n; k >>= 1n, Q = add(Q, Q)) if (k & 1n) R = add(R, Q);
  return isInf(R) ? [0n, 0n] : R;
}

export const operatorPublicKey = (sk) => mul(sk, G);

const keystream = (shared, n) => {
  const key = poseidon3([DOM_OPERATOR, shared[0], shared[1]]);
  return Array.from({ length: n }, (_, i) => poseidon2([key, BigInt(i)]));
};

/** Returns {r, eph, cipher}; r is the private witness `operator_r`. */
export function operatorEncrypt(values, pk, r = randomField() || 1n) {
  const pad = keystream(mul(r, pk), values.length);
  return { r, eph: mul(r, G), cipher: values.map((v, i) => mod(v + pad[i])) };
}

export function operatorDecrypt(sk, eph, cipher) {
  const pad = keystream(mul(sk, eph), cipher.length);
  return cipher.map((c, i) => mod(c - pad[i]));
}
