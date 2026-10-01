import demo from './demo.js';

// Data source: VITE_ZKDESK_MODE, overridable per visit with /dashboard?mode=testnet|demo.
// The testnet adapter (viem, ZK libraries) is only downloaded when it is selected.
const requested = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('mode');
const mode = ['demo', 'testnet'].includes(requested) ? requested : import.meta.env.VITE_ZKDESK_MODE || 'demo';

export default mode === 'testnet' ? (await import('./testnet.js')).default : demo;
