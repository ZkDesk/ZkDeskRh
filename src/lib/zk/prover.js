// UltraHonk prover (bb.js) shared by the browser worker and Node scripts.
// Proofs use the `evm` target (keccak transcript) expected by the Solidity verifiers.
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import { Noir } from '@noir-lang/noir_js';

const EVM = { verifierTarget: 'evm' };

export async function createProver(circuit, options = {}) {
  const api = await Barretenberg.new(options);
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const noir = new Noir(circuit);
  return {
    async prove(inputs) {
      const { witness } = await noir.execute(inputs);
      const { proof, publicInputs } = await backend.generateProof(witness, EVM);
      return { proof: '0x' + [...proof].map((b) => b.toString(16).padStart(2, '0')).join(''), publicInputs };
    },
    destroy: () => api.destroy(),
  };
}
