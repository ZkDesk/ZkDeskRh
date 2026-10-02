# Operations runbook

How ZKdesk is watched and what is done when something goes wrong. Commands run from the repository root.

## Monitoring

- `GET https://zkdesk.tech/api/mainnet/transparency`: desk epoch and health, pause state, pool solvency per asset, relayer and keeper gas, governance settings.
- `node scripts/check-deployment.mjs mainnet`: a read-only check of governance, wiring and source verification. Anyone can run it.
- The tick cron sends alerts (Telegram or a webhook) for: low relayer or keeper gas, overdue desk epochs, a paused desk, failing relays, and every timelock proposal. Each alert repeats at most once an hour.

## Responses

| Situation | Response |
| --- | --- |
| Suspected exploit, bad price or broken desk | The guardian pauses new risk at once: `node scripts/ops/govern-mainnet.mjs pause-desk`. Repaying, adding collateral, closing and every pool withdrawal keep working. Unpausing goes through the timelock. |
| An unexpected timelock proposal | The Safe cancels it during the delay (2 of 3 signatures): `node scripts/ops/govern-mainnet.mjs cancel <operation id>`. |
| Relayer or keeper low on gas | Top up the address shown by `/api/mainnet/relay` (the keeper is the relayer until a keeper key is configured). User relays stop at 0.002 ETH; desk epochs stop at 0.0005 ETH. |
| Desk epochs overdue | Check the desk cron's logs; run the operator by hand with `node scripts/ops/desk.mjs`. New borrowing halts until an epoch lands; nothing else stops. |
| Many failed relays | Read the error codes of recent operations: a stale mark, a moving root or a spent note usually clears on retry. |
| A compromised service key | Replace the key in the hosting environment and fund the new one. For the price-pinning key, also schedule `Marker.setPinner` through the timelock. |
| A compromised Safe signer | The other two signers replace it on the Safe at once (`swapOwner`). |

## Contact

Report security issues privately through the repository's **Security** tab ([SECURITY.md](SECURITY.md)). Operational alerts go to the maintainers' alert channel.
