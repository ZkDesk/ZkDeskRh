import React, { useEffect, useState } from 'react';
import { ZMark } from '../brand/identity.jsx';
import './developer-docs.css';

// Public developer documentation for the live ZKdesk dashboard (/docs). Deliberately contains no
// contract addresses, explorer links, keys, infrastructure identifiers or internal endpoints.

const NAV = [
  ['Getting started', [['introduction', 'Introduction'], ['quickstart', 'Quickstart'], ['networks', 'Networks']]],
  ['Core concepts', [['architecture', 'Architecture'], ['keys', 'Accounts and keys'], ['notes', 'Private notes'], ['proofs', 'Zero-knowledge proofs'], ['relayer', 'Relayer and operations']]],
  ['Product guides', [['balance', 'Private balance'], ['lending', 'Lending pool'], ['credit', 'Private credit'], ['health', 'Health epochs and liquidation'], ['treasury', 'Treasury'], ['payments', 'Payments and receipts'], ['agents', 'AI agents'], ['transparency', 'Transparency']]],
  ['Security', [['privacy', 'Privacy model'], ['governance', 'Governance and safety'], ['status', 'Security status and limitations'], ['eligibility', 'Eligibility']]],
  ['Reference', [['parameters', 'Protocol parameters'], ['api', 'Public API'], ['states', 'Operation states and errors'], ['stack', 'Technology stack'], ['glossary', 'Glossary']]],
];
const IDS = NAV.flatMap(([, items]) => items.map(([id]) => id));

function Callout({ tone = 'note', title, children }) {
  return <aside className={`zd-callout ${tone}`} role="note"><strong>{title}</strong><div>{children}</div></aside>;
}
function Table({ head, rows, caption }) {
  return <div className="zd-table"><table>{caption && <caption>{caption}</caption>}<thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j} data-label={head[j]}>{c}</td>)}</tr>)}</tbody></table></div>;
}
function Code({ label, children }) {
  return <figure className="zd-code">{label && <figcaption>{label}</figcaption>}<pre><code>{children}</code></pre></figure>;
}
function Section({ id, eyebrow, title, children }) {
  return <section id={id} className="zd-section" aria-labelledby={`${id}-title`}><span className="zd-eyebrow">{eyebrow}</span><h2 id={`${id}-title`}><a href={`#${id}`}>{title}</a></h2>{children}</section>;
}
const C = ({ children }) => <code className="zd-inline">{children}</code>;

function Diagram() {
  return <figure className="zd-diagram" aria-label="System architecture">
    <div className="zd-lane"><span className="zd-lane-label">Your device</span>
      <div className="zd-box primary"><strong>Browser client</strong><span>Key derivation · note scanning · witness building · proving in a Web Worker</span></div>
      <div className="zd-box"><strong>Wallet</strong><span>One key-request signature · public deposits</span></div>
    </div>
    <div className="zd-arrow" aria-hidden="true"><span>proof + encrypted outputs</span></div>
    <div className="zd-lane"><span className="zd-lane-label">ZKdesk services</span>
      <div className="zd-box"><strong>Relayer</strong><span>Validates, simulates and submits proofs; pays gas</span></div>
      <div className="zd-box"><strong>Scheduled services</strong><span>Indexer · deposit clearing · marks · rate accrual · desk operator</span></div>
    </div>
    <div className="zd-arrow" aria-hidden="true"><span>verified transactions</span></div>
    <div className="zd-lane"><span className="zd-lane-label">Robinhood Chain</span>
      <div className="zd-box primary"><strong>Protocol contracts</strong><span>Shielded pool · credit desk · lending pool · treasury ledger · mandate registry · marker · verifiers</span></div>
      <div className="zd-box"><strong>External markets</strong><span>USDG · stock tokens · price feeds · swap venue · yield vault</span></div>
    </div>
  </figure>;
}

export default function DeveloperDocs() {
  const [active, setActive] = useState(IDS[0]);
  useEffect(() => {
    const seen = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : Infinity));
      const top = [...seen].filter(([, y]) => y !== Infinity).sort((a, b) => a[1] - b[1])[0];
      if (top) setActive(top[0]);
    }, { rootMargin: '-80px 0px -65% 0px' });
    IDS.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);
  const nav = (onPick) => NAV.map(([group, items]) => <div className="zd-nav-group" key={group}><p>{group}</p>{items.map(([id, label]) => <a key={id} href={`#${id}`} className={active === id ? 'active' : ''} aria-current={active === id ? 'location' : undefined} onClick={onPick}>{label}</a>)}</div>);

  return <div className="zd-docs">
    <a className="zd-skip" href="#main">Skip to content</a>
    <header className="zd-header">
      <a className="zd-brand" href="/"><ZMark /><span>ZKdesk</span><em>Docs</em></a>
      <nav aria-label="Site"><a href="/">Website</a><a className="zd-cta" href="/dashboard">Open dashboard <span aria-hidden="true">↗</span></a></nav>
    </header>
    <div className="zd-shell">
      <aside className="zd-sidebar" aria-label="Documentation">{nav()}<span className="zd-version">Documentation · September 2026</span></aside>
      <details className="zd-mobile-nav"><summary>Contents</summary><nav aria-label="Documentation">{nav((e) => e.currentTarget.closest('details').removeAttribute('open'))}</nav></details>
      <main id="main" className="zd-main">
        <div className="zd-hero">
          <span className="zd-kicker">ZKdesk documentation</span>
          <h1>Build on a confidential balance.</h1>
          <p>How the ZKdesk dashboard works end to end: keys, private notes, zero-knowledge proofs, credit, treasury controls, payments and the services that keep them running on Robinhood Chain.</p>
        </div>

        <Section id="introduction" eyebrow="Getting started" title="Introduction">
          <p>ZKdesk is a confidential finance workspace. It keeps balances, transfers, treasury holdings and payment terms confidential, and it lets their owners disclose exactly what a counterparty needs with a zero-knowledge proof.</p>
          <p>Every action you take in the dashboard is proven in your browser and verified by a smart contract. Your keys never leave your browser. The <a href="#privacy">Privacy model</a> lists exactly what is public and what ZKdesk services can see.</p>
          <div className="zd-cards">
            <a href="#balance"><strong>Private balance</strong><span>Deposit USDG and stock tokens, then hold and send them privately. Deposits and withdrawals are public at the edge of the pool.</span></a>
            <a href="#credit"><strong>Private credit</strong><span>Borrow USDG against tokenized stocks with confidential positions and proven desk health.</span></a>
            <a href="#treasury"><strong>Treasury</strong><span>Shared balances with Owner, Treasurer, Payer and Auditor roles, policies and dual control.</span></a>
            <a href="#payments"><strong>Payments</strong><span>Capped, periodic payment mandates with receipts the recipient can prove to anyone.</span></a>
          </div>
          <Callout tone="warning" title="Status">ZKdesk runs on Robinhood Chain mainnet with real assets. The protocol has not yet been independently audited. Use amounts you are prepared to lose and read <a href="#status">Security status and limitations</a> first.</Callout>
        </Section>

        <Section id="quickstart" eyebrow="Getting started" title="Quickstart">
          <ol className="zd-steps">
            <li><strong>Choose a network.</strong> Open the dashboard and pick <em>Mainnet</em> or <em>Testnet</em> in the top bar. Mainnet uses real USDG and stock tokens; testnet uses free test assets.</li>
            <li><strong>Connect a wallet.</strong> Any browser wallet that exposes an externally owned account works (for example MetaMask). The dashboard asks the wallet to add or switch to the selected Robinhood Chain network.</li>
            <li><strong>Unlock your private notes.</strong> Sign the ZKdesk key request. It is a typed-data signature: it costs no gas and never leaves your device. Your keys are derived from it (see <a href="#keys">Accounts and keys</a>). Or choose <em>Use a passkey</em> to unlock with Face ID, Touch ID, Windows Hello or a security key instead; save the 24-word recovery key it shows when you create it. A passkey account needs the wallet only to add funds.</li>
            <li><strong>Add funds.</strong> Approve the token and confirm the private deposit in your wallet. After a 60-second screening standby the deposit is cleared automatically and becomes spendable.</li>
            <li><strong>Use the workspace.</strong> Send privately, supply to the lending pool, open credit, set up a treasury or create payment mandates. Each action generates a proof locally, typically in 20 to 80 seconds; keep the page open until it confirms.</li>
          </ol>
          <Callout title="Tip">Your private address (<C>zkd:…</C>) is in Settings. Share it to receive private transfers and payments; it reveals no balance. In a treasury workspace, Settings shows the treasury's address instead of yours.</Callout>
        </Section>

        <Section id="networks" eyebrow="Getting started" title="Networks">
          <p>The dashboard serves both networks from the same code. The selection is remembered in your browser and can be set explicitly with the <C>?network=mainnet</C> or <C>?network=testnet</C> query parameter. Keys are bound to the chain ID, so the same wallet has different ZKdesk keys and addresses on each network.</p>
          <Table head={['', 'Mainnet', 'Testnet']} rows={[
            ['Chain ID', '4663', '46630'],
            ['Cash asset', 'USDG (6 decimals)', 'tUSDG test token with an in-app faucet'],
            ['Collateral', 'SPY, QQQ, NVDA, TSLA stock tokens (18 decimals)', 'tSPY, tQQQ, tNVDA, tTSLA test tokens'],
            ['Prices', 'Chainlink feeds, pinned on-chain', 'Simulated feeds with a small random walk'],
            ['Liquidation venue', 'Uniswap v3 pools', 'Simulated market maker'],
            ['Treasury yield', 'Morpho USDG vault (ERC-4626)', 'Simulated ERC-4626 vault'],
            ['Governance delay', '24 hours', '5 minutes'],
          ]} />
        </Section>

        <Section id="architecture" eyebrow="Core concepts" title="Architecture">
          <p>ZKdesk is a client-proved system. The browser holds your keys and proves every action you take; contracts verify proofs and hold the assets; services relay authorized actions and run scheduled upkeep (health epochs, liquidations and opt-in scheduled payments), which they prove themselves.</p>
          <Diagram />
          <h3>Design principles</h3>
          <ul>
            <li><strong>The chain is the source of truth.</strong> The client rebuilds the note tree from contract events and checks its size against the pool before proving; the contract rejects any root it does not know. The indexed mirror used by services holds public data only.</li>
            <li><strong>Proofs authorize, not sessions.</strong> The relayer has no user accounts; a valid proof is the only authorization for a private action.</li>
            <li><strong>Fail closed.</strong> Stale or paused prices, an overdue health attestation or a paused desk stop new borrowing, while repaying, adding collateral and closing keep working unless governance disables the collateral class.</li>
            <li><strong>Idempotent operations.</strong> Every relayed action is keyed by the nullifiers it spends, so a retry can never execute twice.</li>
          </ul>
        </Section>

        <Section id="keys" eyebrow="Core concepts" title="Accounts and keys">
          <p>ZKdesk keys are derived deterministically from one wallet signature or from a passkey, so nothing is stored. Signing the same request again, or unlocking the same passkey, restores the same keys.</p>
          <Code label="Key request (EIP-712, signed with eth_signTypedData_v4)">{`domain:  { name: "ZKDesk", version: "1", chainId }
type:    KeyRequest { purpose: string }
message: "Unlock my ZKDesk private notes. This signature never
          leaves this device and costs no gas."`}</Code>
          <Table head={['Key', 'Derivation', 'Purpose']} rows={[
            ['Spend key', 'HKDF-SHA256(seed, "spend"), reduced into the BN254 field', 'Proves ownership inside circuits; never leaves the proving worker'],
            ['Owner key', 'Derived from the spend key', 'Public owner identifier committed into notes'],
            ['Nullifier key', 'Derived from the spend key', 'Makes each spent note produce a unique, unlinkable nullifier'],
            ['Encryption key', 'HKDF-SHA256(seed, "encrypt"), X25519', 'Decrypts notes and positions addressed to you'],
          ]} />
          <p>The seed is the wallet signature (HKDF salt <C>ZKDesk key v1</C>) or a passkey's 32-byte WebAuthn PRF output for the input <C>ZKDesk passkey v1</C> (HKDF salt <C>ZKDesk passkey v1 &lt;chainId&gt;</C>, so one passkey holds separate mainnet and testnet accounts, both different from any signature account).</p>
          <ul>
            <li>Keys live only in the account worker. A wallet account is wiped when the wallet account or chain changes; a passkey account is wiped when the page closes or the network is switched.</li>
            <li>A passkey account needs no wallet to send, withdraw, borrow or run a treasury: those steps are relayed and paid from notes. MetaMask is asked for only to add funds, and only as the source of the deposit.</li>
            <li>The passkey seed is shown once at creation as a 24-word recovery key (BIP-39 English, the seed plus an 8-bit checksum) and can be shown again from Settings after the passkey confirms. It restores the account without the passkey. ZKdesk stores neither.</li>
            <li>A passkey belongs to the site's domain: it unlocks ZKdesk only on the domain where it was created. The recovery key works anywhere.</li>
            <li>Smart-contract wallets cannot produce the deterministic signature the wallet path relies on. They can use a passkey account and receive withdrawals; depositing from a smart wallet is not supported yet.</li>
            <li>A private address combines the owner key and the encryption key: <C>zkd:</C> followed by both, encoded.</li>
          </ul>
        </Section>

        <Section id="notes" eyebrow="Core concepts" title="Private notes">
          <p>Balances are held as notes in a shielded pool, in the UTXO style. A note is a commitment to an asset, an amount, an owner and a random blinding factor. Spending a note publishes its nullifier, which the pool records to prevent double spending without revealing which note was spent.</p>
          <Code label="Commitments">{`commitment = Poseidon(asset, amount, owner, blinding)
nullifier  = Poseidon(commitment, nullifierKey)
position   = Poseidon(DOM_POS, collateralAsset, collateral, debtScaled, owner, blinding)`}</Code>
          <ul>
            <li>Commitments are appended to an incremental Merkle tree of depth 20 (about one million notes). The pool accepts proofs against any of its 64 most recent roots, so concurrent users do not invalidate each other's proofs.</li>
            <li>Each new note is encrypted to its recipient with X25519 key agreement and XChaCha20-Poly1305 and posted in a contract event, with a one-byte view tag that lets clients skip notes that are not theirs cheaply.</li>
            <li>Transfers are 2-in / 2-out join-splits: up to two notes are spent and up to two are created (typically the payment and your change). A payment that needs more than two notes asks you to combine them first: <strong>Combine notes</strong> (Treasury tab, personal account) merges your USDG notes into one with private self-transfers, one relay fee per merge.</li>
          </ul>
        </Section>

        <Section id="proofs" eyebrow="Core concepts" title="Zero-knowledge proofs">
          <p>Circuits are written in Noir and proven with Barretenberg's UltraHonk backend, which needs no per-circuit trusted setup. Proofs are generated in the browser in a dedicated Web Worker and verified on-chain by generated Solidity verifiers. The toolchain is pinned as a matched Noir and Barretenberg pair.</p>
          <Table head={['Circuit', 'Proves']} rows={[
            ['transact', 'Deposits, private transfers, withdrawals and private conversions (USDG to lending shares and back): 2-in / 2-out with value conservation'],
            ['position', 'All six credit steps (open, draw, repay, add, withdraw collateral, close) against the pinned mark and the LTV limit; encrypts the new position to the desk operator in-circuit'],
            ['health_epoch', 'Desk totals over all 64 slots and a commitment to the set of breached positions'],
            ['liquidate', 'A sealed batch of up to four breached positions sold at one uniform price within a band of the mark'],
            ['ledger', 'Treasury allocate, deallocate and transfer by role, under the treasury policy'],
            ['role_auth', 'Owner actions: create a treasury, rotate roles, set policy, approve a transfer intent'],
            ['treasury_attest', 'A solvency statement: up to eight treasury notes cover a declared liability; the liability and the covering notes\' nullifiers are public, the balance is not'],
            ['mandate_auth', 'Commit, pause, resume or revoke a payment mandate by an authorized role'],
            ['mandate_pull', 'A payment within the mandate cap, period and expiry, at most once per period, producing a receipt leaf'],
            ['receipt', 'That a recipient was paid under a mandate, to one chosen verifier, with optional amount and recipient disclosure'],
          ]} />
          <Callout title="Performance">Browser proving uses multiple threads where the browser allows it and usually takes 20 to 80 seconds per action, depending on the device and the circuit. Keep the tab open until the action confirms; navigating away cancels proving.</Callout>
        </Section>

        <Section id="relayer" eyebrow="Core concepts" title="Relayer and operations">
          <p>Private actions are submitted by the ZKdesk relayer rather than your wallet, so your public address never appears on them and you do not need gas. Deposits are the exception: they move public tokens into the pool and are sent from your own wallet.</p>
          <ol className="zd-steps compact">
            <li>The client builds the proof and encrypted outputs and posts them to the relayer.</li>
            <li>The relayer checks the request shape, supported assets, fee and ciphertext sizes, and derives an intent hash from the nullifiers being spent.</li>
            <li>It simulates the call. A simulation failure is returned immediately with the contract's error and nothing is sent.</li>
            <li>It submits the transaction and waits briefly for the receipt; longer confirmations continue in the background and are reconciled automatically.</li>
          </ol>
          <p>Every relay pays for its gas. The minimum fee is the gas a relayed step can use (5.5M) at the current gas price, valued at the ETH price and converted into the spent asset, and never below a floor: 0.05 USDG, 0.05 lending share or 0.00015 of a stock token. The app pays 25% above the quoted minimum so that a proof made while gas moves is still accepted.</p>
          <Table head={['Step', 'How the fee is paid']} rows={[['Transfer, withdrawal, lend, redeem', 'Privately, from the spent asset, as part of the proof'], ['Credit, treasury and payment steps', 'Their proofs have no fee field, so the app first buys a one-use voucher with a private self-transfer that pays twice the fee (its own gas and the step\'s). The voucher is valid for a day once that transfer confirms.']]} />
          <p>User relays stop while the relayer holds less than 0.002 ETH. Desk epochs, liquidations, price pins and deposit clearing are sent from a separate keeper key, so relay traffic cannot starve them. The relayer reads no IP address; spam is limited by the fee itself. Operation status can be polled through the <a href="#api">public API</a>.</p>
        </Section>

        <Section id="balance" eyebrow="Product guides" title="Private balance">
          <h3>Add funds</h3>
          <p>A deposit approves the pool for the exact amount (on mainnet) and calls the pool from your wallet with a proof that creates a note for you. The deposit then waits in a 60-second screening standby. Once the standby passes it is cleared automatically; a flagged deposit can only be refunded to the address it came from.</p>
          <h3>Send privately</h3>
          <p>Send to any <C>zkd:</C> address. The recipient's note is encrypted to them; the chain records nullifiers, new commitments, the asset and the relay fee, not the amount, sender or recipient.</p>
          <h3>Withdraw</h3>
          <p>Withdrawing spends private notes and pays a public address. The withdrawn amount and the destination address are public by necessity; the notes they came from are not.</p>
        </Section>

        <Section id="lending" eyebrow="Product guides" title="Lending pool">
          <p>The USDG lending pool funds credit. <em>Allocate</em> converts private USDG into private lending-pool shares in a single proof, and <em>Move to liquid</em> converts shares back, subject to the pool's available cash. Shares appreciate as borrowers pay interest. If a liquidation cannot cover a position's debt, the remainder is written off and share value falls accordingly.</p>
          <Table head={['Utilization', 'Borrow rate (APR)']} rows={[['0%', '2%'], ['80% (kink)', '10%'], ['100%', '60%']]} caption="Rates are linear between points. 10% of interest accrues to reserves." />
          <p>A single USDG rate index is checkpointed on-chain at most every ten minutes and at least hourly; a step that keeps a position open must prove at the latest checkpoint, and closing may also use the previous one. If a checkpoint lands while a step is being proven, the app proves it again once.</p>
        </Section>

        <Section id="credit" eyebrow="Product guides" title="Private credit">
          <p>Borrow USDG against stock-token collateral. Each position is a hidden commitment in one of the desk's 64 slots. Its contents are encrypted: the desk operator can read them to prove health and run liquidations, and each step's collateral and borrow amounts are public (see <a href="#privacy">Privacy model</a>).</p>
          <Table head={['Collateral', 'Max LTV to open or draw', 'Liquidation threshold']} rows={[['SPY', '60%', '70%'], ['QQQ', '60%', '70%'], ['NVDA', '45%', '55%'], ['TSLA', '45%', '55%']]} />
          <ul>
            <li><strong>Steps:</strong> open, draw, repay, add collateral, withdraw collateral and close. Each is one proof; closing repays the remaining debt and returns all collateral to your private balance.</li>
            <li><strong>Marks:</strong> prices are pinned on-chain from the feeds and applied once, including any corporate-action multiplier. On mainnet a pinned mark stays usable for 25 hours; on testnet for one hour.</li>
            <li><strong>Market hours:</strong> the NYSE regular session, 9:30 to 16:00 New York time on trading days. Exchange holidays count as off-hours, and early-close days end at 13:00.</li>
            <li><strong>Fail-closed:</strong> drawing USDG requires a usable mark, a recent health attestation and an unpaused desk; withdrawing part of the collateral requires a usable mark and an unpaused desk. Repaying, adding collateral and closing work at any time unless governance disables the collateral class.</li>
          </ul>
        </Section>

        <Section id="health" eyebrow="Product guides" title="Health epochs and liquidation">
          <p>Every 15 minutes during market hours, and hourly outside them, the desk operator proves a health epoch over every slot: the total collateral value, the total debt and a commitment to exactly which positions are below their liquidation threshold. Because the proof covers all slots, a breached position cannot be omitted.</p>
          <p>If no epoch is attested within three intervals, new borrowing halts until one is.</p>
          <h3>Sealed liquidation batches</h3>
          <ul>
            <li>Up to four breached positions of one collateral class are sold together at one uniform price, which must lie within 2% of the mark during market hours (5% outside them).</li>
            <li>Close factor: 20% of the debt, or 100% when health is below 95% of the threshold.</li>
            <li>Liquidation bonus: 2%, or 8% below 95%. Outside market hours only positions below 95% can be liquidated.</li>
            <li>Sale proceeds repay lenders first. The bonus and any surplus go to the protocol's bonus address, the governance Safe on mainnet.</li>
            <li>Unsold collateral stays in the owner's position. The owner sees what was sold and repaid; the public sees batch totals only.</li>
            <li>If one position in a batch changes after the epoch's snapshot (its owner cured it), the batch is skipped on-chain, and the desk re-plans the others and liquidates them in the same epoch.</li>
          </ul>
        </Section>

        <Section id="treasury" eyebrow="Product guides" title="Treasury">
          <p>A treasury is a shared private ledger inside the pool. Its members hold personal role keys behind one role commitment, and the treasury's view key is shared with them as encrypted on-chain key shares.</p>
          <Table head={['Role', 'Can']} rows={[
            ['Owner', 'Everything, plus creating the treasury, rotating roles, setting policy and approving transfers above the threshold'],
            ['Treasurer', 'Add funds, allocate to and from the yield vault, move funds and manage mandates'],
            ['Payer', 'Send, withdraw and pay or manage mandates'],
            ['Auditor', 'View balances and history; cannot move funds'],
          ]} />
          <ul>
            <li><strong>Policy:</strong> an allocation cap and an Owner-approval threshold. A transfer above the threshold by a non-Owner is sealed as a request; the Owner approves the exact intent and the requester completes it.</li>
            <li><strong>Yield:</strong> idle USDG can be allocated to an ERC-4626 vault. Vault shares are held by the pool on the treasury's behalf.</li>
            <li><strong>Solvency statements:</strong> prove that treasury notes cover a declared liability. The statement reveals that it holds and the declared liability, never the balance; the covering notes' nullifiers are published, so later spends of those notes can be linked to it.</li>
            <li><strong>Access:</strong> every role, including Auditor and a scheduler acting as Payer, receives the treasury key. Rotating roles changes permissions but not the key, so former members can still read the treasury.</li>
            <li><strong>Workspaces:</strong> Settings switches between your personal account and every treasury where you hold a role; the role picker lists only roles you hold.</li>
          </ul>
        </Section>

        <Section id="payments" eyebrow="Product guides" title="Payments and receipts">
          <p>A mandate is a standing permission for a treasury to pay one recipient. Its terms are encrypted to the treasury; only a commitment and status changes are public.</p>
          <Table head={['Field', 'Description']} rows={[
            ['Recipient', 'A ZKdesk private address'],
            ['Asset', 'USDG, or a stock token paid at the pinned mark with the cap expressed in USDG'],
            ['Cap and period', 'Maximum per payment; monthly, weekly or one-time'],
            ['Expiry', 'After this date no payment is possible'],
            ['Invoice reference', 'Optional; bound into the mandate'],
          ]} />
          <p>Payments run from a member's browser with <em>Pay now</em>, at most once per period. To automate them, make the ZKdesk scheduler the treasury's Payer; due periods are then paid hourly at the cap. Making the scheduler Payer gives whoever holds its key (the ZKdesk service) the Payer role: it can pay committed mandates and make transfers below the dual-control threshold. The service only ever proves mandate payments, but that is a policy of the code, not a limit of the key. Mandates can be paused, resumed and revoked.</p>
          <h3>Receipts</h3>
          <p>Every payment adds a leaf to the receipt tree. The recipient can prove from Activity that they were paid, addressed to one verifier's address, optionally disclosing the amount and themselves. The proof is bound to that verifier and can be checked independently against the chain.</p>
        </Section>

        <Section id="agents" eyebrow="Product guides" title="AI agents">
          <p>An AI agent can hold its own private ZKdesk account. It proves every step on its own machine and ZKdesk relays it, so the agent needs no wallet and no gas. The agent SDK and an MCP server are in the repository's <C>agent/</C> folder (Node 22.12+).</p>
          <Code label="Set up (from a clone of the public repository)">{`pnpm install
node agent/cli.mjs keygen            # ZKDESK_SEED=0x… and the agent's zkd: address
ZKDESK_SEED=0x… node agent/cli.mjs balance`}</Code>
          <p>Fund the agent with <em>Send privately</em> to its <C>zkd:</C> address. To let it pay from a treasury, paste that address as the Payer in <em>Manage roles</em>.</p>
          <Code label="MCP server (Claude Desktop, Claude Code or any MCP client)">{`{
  "mcpServers": {
    "zkdesk": {
      "command": "node",
      "args": ["/path/to/ZkDeskRh/agent/mcp.mjs"],
      "env": { "ZKDESK_SEED": "0x…", "ZKDESK_NETWORK": "mainnet", "ZKDESK_MAX_PER_TX": "50", "ZKDESK_MAX_PER_DAY": "100", "ZKDESK_ALLOW_TO": "zkd:…" }
    }
  }
}`}</Code>
          <Table head={['Tool', 'What it does']} rows={[
            ['zkdesk_address, zkdesk_balance', "The agent's private address and USDG balance"],
            ['zkdesk_send, zkdesk_withdraw', 'Private transfer to a zkd: address, or out to a 0x address'],
            ['zkdesk_treasuries, zkdesk_pay', 'Treasuries where the agent holds a role; pay from one'],
            ['zkdesk_requests, zkdesk_complete', "Payments above the Owner's threshold wait for approval; complete them once approved"],
            ['zkdesk_mandates, zkdesk_pay_mandate', "Pay a mandate's current period, up to its cap"],
            ['zkdesk_combine', "Merge the agent's notes into one: a payment can spend at most two, so an agent paid many times combines first"],
            ['zkdesk_fetch_paid', 'Fetch an https URL; if it asks for payment (402), pay up to max_price and fetch again'],
            ['zkdesk_incoming, zkdesk_wait_for_payment', 'Payments the agent received from others, or wait for one (optionally of an exact amount) before acting'],
            ['zkdesk_pay_link, zkdesk_request_link', 'Pay a payment request link (from the dashboard or another agent), or create one so others can pay the agent'],
            ['zkdesk_receipts, zkdesk_prove_receipt, zkdesk_verify_receipt', "Prove a payment the agent received, or check anyone's receipt"],
          ]} />
          <p>In code: <C>{"const agent = await createAgent({ seed, network: 'mainnet', maxPerTx: '50' })"}</C> from <C>agent/index.mjs</C>, then <C>agent.send({'{'} to, amount {'}'})</C>, <C>agent.pay(treasuryId, {'{'} to, amount {'}'})</C> and so on. Amounts are USDG decimal strings.</p>
          <p>From the dashboard: open the treasury, go to <em>Treasury → AI agent → Add an agent</em>, and paste the agent's address. Set the amount above which you approve each payment, and optionally how many payments it may make without approval per day or week. The panel shows the current Payer, the threshold and the count used. <em>Remove agent</em> makes you the Payer again. A removed agent can no longer pay, but it keeps the viewing key it was given and can still read the treasury until its funds move to a new treasury (re-keying is not built yet).</p>
          <h3>Pay-per-call APIs</h3>
          <p>Any HTTP API can charge agents per request with <C>agent/paywall.mjs</C>, using its own ZKdesk account.</p>
          <ol>
            <li>An unpaid request gets <C>402</C> with a one-time challenge: a request id, a payment link to the service's private address and an expiry. Each open challenge has its own amount: the price plus a few millionths of a USDG.</li>
            <li>The agent (<C>zkdesk_fetch_paid</C>, never above its <C>max_price</C> and within its limits) pays privately and repeats the request with the <C>x-zkdesk-request</C> header.</li>
            <li>The service answers once a payment of exactly that amount, made after the challenge, is in the pool.</li>
          </ol>
          <p>Each payment unlocks one request. A deposit still in screening does not count, because its sender can take it back. The service learns nothing about who paid.</p>
          <Code label="Service">{`import { createAgent } from './agent/index.mjs';
import { createPaywall, fileStore } from './agent/paywall.mjs';
const account = await createAgent({ seed: process.env.SERVICE_SEED, network: 'mainnet' });
const paywall = createPaywall({ agent: account, price: '0.25', store: fileStore('./paywall.json') });
http.createServer(async (req, res) => {
  if (await paywall.guard(req, res)) res.end('the paid answer');
});`}</Code>
          <ul>
            <li><strong>State:</strong> open challenges and used payments live in a store.
              <ul>
                <li><C>memoryStore()</C>, the default, keeps them in one process and forgets them on a restart.</li>
                <li><C>fileStore(path)</C> keeps them across restarts, for one process.</li>
                <li><C>redisStore(client)</C> (a connected node-redis client) is for any number of instances. Each payment is claimed atomically, so it still unlocks exactly one request. The Redis must not evict keys early (<C>maxmemory-policy noeviction</C>), and each service account needs its own <C>prefix</C>.</li>
                <li>Paywalls on one account that are given no store share one, so their amounts never collide.</li>
              </ul></li>
            <li><strong>Limits:</strong> each caller can hold at most 5 open challenges (an IPv6 caller is counted by its /64), and a challenge expires after 5 minutes.</li>
            <li><strong>Behind a reverse proxy:</strong> pass <C>clientOf</C> to read the client address from the header your proxy sets. Otherwise every caller shares the proxy's limit.</li>
            <li><strong>On the paying side:</strong> <C>zkdesk_fetch_paid</C> fetches only public https hosts and refuses a challenge that expires within two minutes. After paying, it never throws: if the service does not answer, it returns what it paid and the request id to finish with. <C>ZKDESK_ALLOW_HTTP=1</C> lifts the https and public-host rules for local tests only.</li>
          </ul>
          <h3>Where the limits are enforced</h3>
          <ul>
            <li><strong>By the contracts and circuits</strong>, when the agent is a treasury's Payer: it can pay mandates up to their caps, once per period, and transfer up to the Owner's dual-control threshold. Anything above becomes a request that only the Owner can approve, within the treasury's transfer-count limit. It cannot allocate, change roles or approve. The Owner can revoke it in Manage roles at any time.</li>
            <li><strong>On the agent's machine only</strong>, before anything is proven:
              <ul>
                <li><C>ZKDESK_MAX_PER_TX</C> (default 50 USDG) caps one payment.</li>
                <li><C>ZKDESK_MAX_PER_DAY</C> (default 100 USDG) caps a rolling 24 hours, relay fees included. It is kept in a file only you can read, so a restart does not reset it.</li>
                <li><C>ZKDESK_ALLOW_TO</C> (comma-separated <C>zkd:</C> or 0x addresses) limits who it may pay; mandate recipients are fixed by the Owner.</li>
                <li><C>ZKDESK_TREASURIES</C> limits which treasuries it acts in.</li>
                <li><C>ZKDESK_MAX_FEE</C> (default 2 USDG) refuses an unusually high relay fee.</li>
              </ul>
              Set any of them to <C>off</C> to remove it. These protect against a confused or prompt-injected model, not against someone who has the seed. Treasury names, mandate labels and payment-link memos are written by other people; the server marks them as untrusted.</li>
            <li><strong>Getting paid:</strong> a payment counts as received only once it is in the pool. A deposit to the agent's address spends about a minute in screening, during which its sender can take it back, so <C>zkdesk_wait_for_payment</C> reports it as pending, not received. Deliver only on <C>received: true</C>. A requested amount gets a few millionths of a USDG added, so each link's payment can be told apart.</li>
            <li>The seed is the account. Anyone holding it can spend the agent's own balance and act as its role. Keep the agent's own balance small and its treasury role bounded. A recipient allow-list and a cumulative budget enforced in the circuit are planned for the next contract release.</li>
          </ul>
        </Section>

        <Section id="transparency" eyebrow="Product guides" title="Transparency">
          <p>The Transparency view, available without a wallet, shows the protocol's public aggregates so anyone can check its health.</p>
          <ul>
            <li>Desk epochs with total collateral value and debt, and liquidation batch totals</li>
            <li>Pool solvency per asset: tokens held versus notes outstanding</li>
            <li>Lending pool assets, cash, debt, utilization and rate</li>
            <li>Treasury solvency statements, and mandate and receipt counts</li>
            <li>Governance delay, multisig threshold and relayer gas status</li>
          </ul>
          <p>It is built only from data that is already public on-chain.</p>
        </Section>

        <Section id="privacy" eyebrow="Security" title="Privacy model">
          <Table head={['', 'Public', 'Visible to ZKdesk services', 'Private']} rows={[
            ['Keys', '—', 'Never', 'Spend, view and encryption keys stay in your browser'],
            ['Balance', 'Totals per asset held by the pool', '—', 'Your notes, amounts and owners'],
            ['Deposits and withdrawals', 'Amount, token and public address at the edge of the pool', '—', 'Which later spends they fund'],
            ['Transfers', 'That a transaction occurred, its asset, fee and time', 'The relayer sees the request and its timing', 'Amount, sender and recipient'],
            ['Credit', 'Each step\'s collateral, borrow and repay amounts and slot; desk totals per epoch; batch totals', 'The desk operator reads each position\'s collateral, debt and owner key', 'Which wallet owns a position'],
            ['Treasury', 'The treasury identifier, action type and allocated or withdrawn amounts; solvency statement results', 'The opt-in scheduler, if made Payer, can read that treasury and act as its Payer', 'Balances, members, roles and policy values'],
            ['Payments', 'Mandate commitments, status changes, each payment\'s period and timing', 'The opt-in scheduler, for treasuries that use it', 'Recipient, terms and amounts'],
          ]} />
          <Callout title="Known correlations">Slot numbers, treasury identifiers, mandate commitments and transaction timing are public and can be correlated. Deposits and withdrawals of unusual amounts are easier to link. Waiting between deposit and use, and using round amounts, improves privacy.</Callout>
        </Section>

        <Section id="governance" eyebrow="Security" title="Governance and safety">
          <ul>
            <li><strong>Timelock:</strong> configuration of the protocol contracts is owned by a 2-of-3 governance Safe acting through a timelock (48 hours on mainnet once a change already scheduled through it takes effect on 3 October 2026; 24 hours until then), so every change is visible before it takes effect. Every proposal also alerts the operators.</li>
            <li><strong>Guardian:</strong> a guardian can pause new risk on the credit desk immediately. A pause stops new borrowing and partial collateral withdrawals; it never blocks repaying, adding collateral or closing.</li>
            <li><strong>Pool:</strong> the shielded pool has no owner and no upgrade path; deposits during standby can always be refunded to their origin. Its modules (credit desk, treasuries, payments) were fixed at deployment. Governance only decides which assets may enter; withdrawals and transfers never depend on it.</li>
            <li><strong>Solvency checks:</strong> pool balances are compared with outstanding notes for every asset and published on Transparency.</li>
            <li><strong>Gas safety:</strong> desk epochs, liquidations, price pins and deposit clearing run from their own keeper key, so relay traffic cannot starve them; user relays stop at a balance floor.</li>
          </ul>
          <h3>Governance powers</h3>
          <p>These powers exist today and are listed so you can judge the trust involved. The three Safe signer keys, the guardian and the deposit screener are held by the project's developer (the guardian and screener are separate keys from the deployer); the relayer and keeper keys are operated by ZKdesk.</p>
          <ul>
            <li><strong>After the 48-hour timelock:</strong> list or de-list an asset for new deposits (a de-listed asset can still be withdrawn from the pool and the desk, but treasury transfers and mandate payments of it pause until it is listed again); change collateral class parameters, including the minimum position size (a disabled class still allows repaying, adding collateral and closing); change the liquidation venue and the bonus address; change the price-pinning key; unpause the desk. Governance cannot add a contract that moves pool funds.</li>
            <li><strong>Immediately, without the timelock:</strong> the guardian can pause new borrowing and partial withdrawals; the deposit screener can flag a deposit during its standby so that it can only be refunded; the pinning key sets the market-hours flag, which selects the liquidation price band and epoch interval.</li>
          </ul>
        </Section>

        <Section id="status" eyebrow="Security" title="Security status and limitations">
          <Callout tone="warning" title="Not audited by a firm">The circuits, contracts, relayer and key derivation have not been audited by an independent firm. An automated AI audit (October 2026) found two high and seven medium issues; all are fixed in the current deployment, each with a test. Treat ZKdesk as early software and keep amounts small.</Callout>
          <ul>
            <li>The governance Safe needs two of three signatures, but all three keys are held by the project's developer rather than independent parties or hardware devices.</li>
            <li>The desk operator can read the contents of credit positions, including each one's owner key, in order to prove health and run liquidations. Moving the operator into a trusted execution environment is planned.</li>
            <li>One relayer submits private actions and one keeper runs protocol upkeep. While they are unavailable, funds stay in the contracts, but private actions, deposit clearing, price pinning and health epochs pause, so new borrowing halts and liquidations wait.</li>
            <li>Credit, treasury and payment steps pay their relay fee with a prepaid voucher, bought by a private self-transfer from the acting member's personal balance, so each such step takes one extra proof.</li>
            <li>The 10% of interest set aside as reserves has no withdrawal path yet; it stays in the lending pool, does not count toward lender shares, and first covers any debt written off in a liquidation.</li>
            <li>Deposit screening is a fixed standby; no third-party screening provider is connected yet.</li>
            <li>Only externally owned accounts are supported, and browser proving can take over a minute on slower devices.</li>
          </ul>
        </Section>

        <Section id="eligibility" eyebrow="Security" title="Eligibility">
          <p>Stock tokens are issued by third parties and carry their own eligibility and transfer rules. Stock Token features are not intended for US persons.</p>
          <p>ZKdesk does not determine anyone's eligibility. You are responsible for complying with the laws and terms that apply to you and to the assets you hold. Nothing in this documentation is an offer of a financial product.</p>
        </Section>

        <Section id="parameters" eyebrow="Reference" title="Protocol parameters">
          <Table head={['Parameter', 'Value']} rows={[
            ['Note tree depth / accepted recent roots', '32 / 1,024'],
            ['Inputs and outputs per transfer', '2 and 2'],
            ['Deposit screening standby', '60 seconds'],
            ['Credit desk slots', '64'],
            ['Minimum position', 'About $1,000 of collateral when opening or after a withdrawal (per class, set by governance): filling all 64 slots ties up $64,000'],
            ['Idle position eviction', 'A position without debt and without activity for 1 day; its collateral returns to the owner as a note'],
            ['Health epoch interval', '15 minutes in market hours, 1 hour outside'],
            ['Borrowing halts after', '3 epoch lengths without an attestation (45 minutes in market hours, 3 hours outside)'],
            ['Liquidation batch size', 'Up to 4 positions of one class'],
            ['Liquidation price band', '2% in market hours, 5% outside'],
            ['Close factor', '20%, or 100% below 95% health'],
            ['Liquidation bonus', '2%, or 8% below 95% health'],
            ['Interest to reserves', '10%'],
            ['Solvency statement size', 'Up to 8 treasury notes'],
            ['Mark validity', '25 hours on mainnet, 1 hour on testnet'],
            ['Governance delay', '48 hours on mainnet, 5 minutes on testnet'],
            ['Epoch marks', 'The current pin; the previous one only within 10 minutes of a new round'],
            ['Step marks', 'The current pin; the previous one within 10 minutes of a new round only if it is not higher'],
            ['Minimum debt', '250 USDG: debt is zero or at least this; a partial liquidation that would leave less repays in full'],
            ['Credit step rules', 'Every step moves collateral or debt and leaves the position healthy at the liquidation threshold, at the current pin'],
            ['Step interval', 'One borrow or withdrawal per position every 10 minutes; adding collateral, repaying and closing are always available'],
            ['Eviction activity', 'Opening, debt moves and collateral moves of at least the class minimum; smaller top-ups do not delay eviction'],
            ['Epoch snapshots', 'Each epoch proves one snapshot of the slots, at most 30 minutes old, used once; a batch over a changed slot is skipped'],
          ]} />
        </Section>

        <Section id="api" eyebrow="Reference" title="Public API">
          <p>The dashboard's services expose a small public HTTP API on the site's origin. Mainnet endpoints live under <C>/api/mainnet</C>; testnet endpoints under <C>/api</C>. Responses are JSON. Endpoints return only public data or sealed payloads.</p>
          <h3><span className="zd-method get">GET</span> /api/mainnet/transparency</h3>
          <p>Public protocol aggregates, cached for 30 seconds at the edge and served stale for up to 60 more while refreshing.</p>
          <Code label="Response (abridged, illustrative values)">{`{
  "at": "2026-09-29T21:08:14.074Z",
  "desk": { "epoch": 40, "healthy": true, "paused": false, "marketOpen": true,
            "lastAttestedAt": 1790715654000, "epochs": [...], "batches": [...] },
  "lending": { "totalAssets": "3000001", "cash": "3000001", "debt": "0",
               "utilizationBps": 0, "aprBps": 200 },
  "solvency": [ { "asset": "USDG", "balance": "5969999", "backed": "5969999",
                  "ok": true, "decimals": 6 } ],
  "treasuries": { "count": 1, "statements": [...] },
  "payments": { "mandates": { "revoked": 2 }, "receipts": 1 },
  "operations": { "relayerStatus": "ok", "timelockDelay": 86400, ... }
}`}</Code>
          <h3><span className="zd-method get">GET</span> /api/mainnet/relay</h3>
          <p>Relayer address, availability and the live minimum relay fees in base units, per asset: <C>{'{ relayer, minFee, fees, voucherPrice, available }'}</C>. <C>minFee</C> is the USDG minimum.</p>
          <h3><span className="zd-method post">POST</span> /api/mainnet/relay</h3>
          <p>Submits a private action. The body is produced by the ZKdesk client library and contains a <C>kind</C>, the <C>proof</C> with its public inputs, and <C>ext</C> data (encrypted outputs, recipient, fee). The proof is the only authorization.</p>
          <Table head={['Status', 'Meaning']} rows={[
            ['200', 'Confirmed, failed on-chain, or a duplicate of an operation already in flight (returns that operation)'],
            ['202', 'Submitted; poll the operation for the result'],
            ['400', 'The request is malformed or does not meet relay rules (for example the fee)'],
            ['422', 'Simulation failed; errorCode names the contract error; nothing was sent'],
            ['502', 'Sending was uncertain; the operation stays queued and is reconciled automatically'],
            ['503', 'The relayer is unavailable'],
          ]} />
          <h3><span className="zd-method get">GET</span> /api/mainnet/ops/:id</h3>
          <p>Status of a relayed operation: <C>{'{ opId, kind, status, txHash, errorCode }'}</C>.</p>
          <h3><span className="zd-method get">GET</span> /api/mainnet/requests?ledger=0x…</h3>
          <p>The latest sealed approval requests for a treasury (up to 50 from the last 14 days): <C>{'{ requests: [{ id, ciphertext, created_at }] }'}</C>.</p>
          <h3><span className="zd-method post">POST</span> /api/mainnet/requests</h3>
          <p>Stores a sealed approval request <C>{'{ ledgerId, ciphertext }'}</C> (up to 4 KB) for a treasury's dual-control flow. The endpoint has no authentication: anyone can read or post ciphertexts, but only the treasury's members hold the key to open them, and clients ignore anything that does not open. Request status comes from the chain, not from this mailbox.</p>
        </Section>

        <Section id="states" eyebrow="Reference" title="Operation states and errors">
          <Table head={['State', 'Meaning']} rows={[['queued', 'Accepted; not yet sent, or sending is being confirmed'], ['submitted', 'Sent; waiting for the block'], ['confirmed', 'Included and successful'], ['failed', 'Reverted or refused; nothing moved']]} />
          <Table head={['Message', 'What to do']} rows={[
            ['This amount spans more than two private notes', 'Use Combine notes on the Treasury tab of your personal account, then retry'],
            ['The desk health attestation is overdue', 'New borrowing is paused until the next epoch; repay and close still work'],
            ['The lending pool does not have enough USDG right now', 'Try a smaller amount or wait for repayments'],
            ['The network RPC is behind', 'Wait a moment and retry; the client waits for the node to catch up'],
            ['Submitted, but not confirmed yet', 'It is checked automatically; refresh in a minute before retrying'],
          ]} />
        </Section>

        <Section id="stack" eyebrow="Reference" title="Technology stack">
          <Table head={['Layer', 'Technology']} rows={[
            ['Interface', 'React 19, Vite 7'],
            ['Chain access', 'viem, EIP-6963 wallet discovery'],
            ['Circuits', 'Noir, Barretenberg UltraHonk (bb.js in the browser)'],
            ['Hashing', 'Poseidon over BN254 (circuit, client and contract parity)'],
            ['Encryption', 'X25519, XChaCha20-Poly1305, HKDF-SHA256; Grumpkin for operator encryption in-circuit'],
            ['Contracts', 'Solidity with Foundry; OpenZeppelin timelock and ERC-4626'],
            ['Services', 'Serverless functions with scheduled jobs and an indexed Postgres mirror of public events'],
          ]} />
        </Section>

        <Section id="glossary" eyebrow="Reference" title="Glossary">
          <dl className="zd-glossary">
            <div><dt>Note</dt><dd>A private, encrypted record of an amount of one asset owned by one key.</dd></div>
            <div><dt>Commitment</dt><dd>The public hash of a note; reveals nothing about its contents.</dd></div>
            <div><dt>Nullifier</dt><dd>A value published when a note is spent; prevents double spending without identifying the note.</dd></div>
            <div><dt>Mark</dt><dd>The on-chain price of a collateral asset used by credit proofs.</dd></div>
            <div><dt>Epoch</dt><dd>A proven snapshot of desk health covering every credit slot.</dd></div>
            <div><dt>Mandate</dt><dd>A treasury's capped, periodic permission to pay one recipient.</dd></div>
            <div><dt>Receipt</dt><dd>A proof, addressed to one verifier, that a payment was received.</dd></div>
            <div><dt>Relayer</dt><dd>The service that submits private actions and pays their gas.</dd></div>
          </dl>
        </Section>

        <footer className="zd-footer"><span>ZKdesk documentation</span><span>Information here describes the software as deployed and is not financial advice or an offer.</span></footer>
      </main>
    </div>
  </div>;
}
