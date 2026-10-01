// GET /api/ops/:id — status of a relayed operation (queued | submitted | confirmed | failed | replaced).
import { db, publicClient, json } from '../_lib/server.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  const id = req.query?.id;
  if (!UUID.test(id || '')) return json(res, 400, { error: 'invalid_id' });
  const { rows: [op] } = await db.query('select op_id, kind, status, tx_hash, error_code, updated_at from public.operations where op_id = $1', [id]);
  if (!op) return json(res, 404, { error: 'not_found' });
  if (op.status === 'submitted' && op.tx_hash) {
    const receipt = await publicClient.getTransactionReceipt({ hash: op.tx_hash }).catch(() => null);
    if (receipt) {
      op.status = receipt.status === 'success' ? 'confirmed' : 'failed';
      op.error_code = op.status === 'failed' ? 'reverted' : null;
      await db.query('update public.operations set status = $2, error_code = $3, updated_at = now() where op_id = $1', [id, op.status, op.error_code]);
    }
  }
  return json(res, 200, { opId: op.op_id, kind: op.kind, status: op.status, txHash: op.tx_hash, errorCode: op.error_code });
}
