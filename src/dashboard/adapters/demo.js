import { applyAction, loadState, validateAction } from '../model.js';

// Local simulation: sample state in this browser, no chain or backend.
export default {
  mode: 'demo',
  load: loadState,
  validate: validateAction,
  submit: async (state, type, values) => applyAction(state, type, values),
};
