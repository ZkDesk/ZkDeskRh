// Mainnet (4663) route: the same handler as /api/cron/tick, loaded after selecting the network.
globalThis.ZKDESK_NETWORK = 'mainnet';
const { deployment } = await import('../../../src/lib/chain/config.js');
const notDeployed = (req, res) => { res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end('{"error":"mainnet_not_deployed"}'); };
const handler = deployment.pool ? (await import('../../cron/tick.js')).default : notDeployed;
export default handler;
