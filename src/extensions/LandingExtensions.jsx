import React, { useRef, useState } from 'react';
import './extensions.css';

function Icon({ name = 'arrow', className = '', ...props }) {
  const paths = {
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    lock: <><rect x="6" y="10" width="12" height="10" rx="3" /><path d="M9 10V7a3 3 0 0 1 6 0v3M12 14v2" /></>,
    credit: <><path d="M4 16l5-5 4 3 7-9M14 5h6v6" /><path d="M4 5v15h16" /></>,
    treasury: <><path d="M4 8l8-4 8 4v2H4zM6 12v6M12 12v6M18 12v6M4 20h16" /></>,
    payment: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 10h18M7 15h4" /></>,
    proof: <><path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6" /></>,
    key: <><circle cx="8" cy="9" r="4" /><path d="M11 12l8 8M15 16l3-3M17 18l3-3" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    check: <><path d="M5 12l4 4L19 6" /></>,
  };
  return <svg className={`zk-icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.arrow}</svg>;
}

function SectionHead({ label, title, description, number }) {
  return <div className="zk-section-head">
    <p className="zk-section-index">{number}</p>
    <p className="zk-section-label">{label}</p>
    <div className="zk-section-intro"><h2>{title}</h2>{description && <p>{description}</p>}</div>
  </div>;
}

function CreditMiniature() {
  return <div className="zk-mini zk-mini-credit" aria-hidden="true">
    <div className="zk-mini-top"><span><i className="zk-mini-dot" /> Credit position</span><Icon name="lock" /></div>
    <div className="zk-credit-orbit"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="48" className="zk-orbit-track" /><circle cx="60" cy="60" r="48" className="zk-orbit-value" /></svg><div><span>42<span className="zk-mini-percent">%</span></span><small>Sample LTV</small></div></div>
    <div className="zk-mini-bottom"><span>Position details</span><span><Icon name="lock" /> Confidential</span></div>
  </div>;
}
function TreasuryMiniature() {
  return <div className="zk-mini zk-mini-treasury" aria-hidden="true">
    <div className="zk-mini-top"><span>Treasury balance</span><Icon name="treasury" /></div>
    <div className="zk-masked-balance"><span>•••,•••</span><span className="zk-mini-unit">USDG</span></div>
    <div className="zk-allocation-strip"><i /><i /><i /></div>
    <div className="zk-allocation-legend"><span>Liquid</span><span>Allocated</span><span>Collateral</span></div>
    <div className="zk-mini-roles"><span>Owner</span><span>Treasurer</span><span>Auditor <Icon name="lock" /></span></div>
  </div>;
}
function PaymentsMiniature() {
  return <div className="zk-mini zk-mini-payments" aria-hidden="true">
    <div className="zk-mini-top"><span>Payment mandate</span><Icon name="payment" /></div>
    <div className="zk-payment-recipient"><span className="zk-avatar-stack"><i>AL</i><i>MK</i><i>JS</i></span><span>Studio payroll<small>3 demo recipients</small></span></div>
    <div className="zk-payment-rule"><span>Spending cap</span><strong>Bounded</strong></div>
    <div className="zk-payment-rule"><span>Disclosure</span><strong>Your choice <Icon name="lock" /></strong></div>
    <div className="zk-receipt-strip"><Icon name="proof" /><span>One payment. A private receipt.</span><Icon /></div>
  </div>;
}

const products = [
  { key: 'credit', number: '01', title: 'Credit', heading: 'Capital, without the exposure.', description: 'Access USDG against tokenized assets. Keep individual positions confidential.', miniature: CreditMiniature, action: 'Explore credit' },
  { key: 'treasury', number: '02', title: 'Treasury', heading: 'Every role. One treasury.', description: 'Give your team precise permissions. Share a solvency proof, with scoped disclosure.', miniature: TreasuryMiniature, action: 'Explore treasury' },
  { key: 'payments', number: '03', title: 'Payments', heading: 'Pay privately. Prove precisely.', description: 'Bound payroll and invoices with clear mandates. Share receipts on your terms.', miniature: PaymentsMiniature, action: 'Explore payments' },
];

export function ProductCards() {
  return <section id="workspace-tools" className="zk-extension zk-tools section bg-off-white" aria-labelledby="zk-tools-title">
    <div className="zk-extension-grid">
      <SectionHead number="01 /" label={<>The workspace<br /><span>Three instruments</span></>} title={<span id="zk-tools-title">One balance.<br />Three ways to put it to work.</span>} description="Credit, treasury, and payments. Designed to work as one confidential system." />
      <div className="zk-product-grid">
        {products.map(({ key, number, title, heading, description, miniature: Miniature, action }) => <article className={`zk-glass-card zk-product-card zk-product-${key}`} key={key}>
          <div className="zk-product-eyebrow"><span>{number}</span><span>{title}</span><Icon name={key === 'payments' ? 'payment' : key} /></div>
          <Miniature />
          <div className="zk-product-copy"><h3>{heading}</h3><p>{description}</p></div>
          <a className="zk-text-link" href={`/dashboard?view=${key}`}><span>{action}</span><span className="zk-link-arrow"><Icon /></span></a>
        </article>)}
      </div>
      <p className="zk-section-note"><span className="zk-outline-dot" /> Live on Robinhood Chain <span>Illustrations show the workspace. The dashboard runs on mainnet with real assets.</span></p>
    </div>
  </section>;
}

const steps = [
  { title: 'Bring your assets.', summary: 'A confidential starting point.', copy: 'Deposit supported USDG or tokenized assets into your confidential workspace.', label: 'Assets', icon: 'treasury' },
  { title: 'Put capital to work.', summary: 'Your assets. More possibility.', copy: 'Open a collateralized credit position or allocate treasury assets through supported vaults.', label: 'Capital', icon: 'credit' },
  { title: 'Set precise permissions.', summary: 'Access with intention.', copy: 'Assign role keys and bound payment mandates by amount, period, recipient, and expiry.', label: 'Permissions', icon: 'key' },
  { title: 'Move funds. Share proof.', summary: 'Only what needs to be shared.', copy: 'Pay people and invoices, receive receipts, and disclose only the information a counterparty needs.', label: 'Disclosure', icon: 'proof' },
];

function WorkflowPreview({ index }) {
  if (index === 0) return <div className="zk-workflow-screen">
    <div className="zk-screen-heading"><span>Supported assets</span><span className="zk-screen-tag">Live</span></div>
    {[['$', 'USDG', 'Dollar balance'], ['S', 'SPY', 'Tokenized collateral'], ['Q', 'QQQ', 'Tokenized collateral']].map(([mark, name, caption]) => <div className="zk-asset-row" key={name}><span className={`zk-asset-mark ${name === 'USDG' ? 'zk-asset-blue' : ''}`}>{mark}</span><span><strong>{name}</strong><small>{caption}</small></span><Icon name="plus" /></div>)}
    <div className="zk-screen-footer"><Icon name="lock" /><span>Assets enter a confidential ledger.</span></div>
  </div>;
  if (index === 1) return <div className="zk-workflow-screen">
    <div className="zk-screen-heading"><span>Credit position</span><span className="zk-screen-tag">Illustrative</span></div>
    <div className="zk-preview-value"><small>Borrowing asset</small><strong>USDG <span>↗</span></strong><span>Capital against supported collateral</span></div>
    <div className="zk-capital-bridge"><span><Icon name="treasury" />Collateral</span><i /><Icon name="lock" /><i /><span><Icon name="credit" />Credit</span></div>
    <div className="zk-screen-footer"><Icon name="proof" /><span>Aggregate health. Private positions.</span></div>
  </div>;
  if (index === 2) return <div className="zk-workflow-screen">
    <div className="zk-screen-heading"><span>Workspace roles</span><span className="zk-screen-tag">Role keys</span></div>
    {[['Owner', 'Manage roles', 'Full control'], ['Treasurer', 'Allocate assets', 'Scoped'], ['Payer', 'Execute mandates', 'Bounded'], ['Auditor', 'Inspect records', 'View only']].map(([role, task, scope]) => <div className="zk-permission-row" key={role}><span><strong>{role}</strong><small>{task}</small></span><span>{scope}<Icon name={role === 'Owner' ? 'key' : 'lock'} /></span></div>)}
  </div>;
  return <div className="zk-workflow-screen">
    <div className="zk-screen-heading"><span>Receipt disclosure</span><span className="zk-screen-tag">Selective</span></div>
    <div className="zk-proof-emblem"><Icon name="proof" /></div>
    <div className="zk-disclosure-line"><span>Payment received</span><span><Icon name="check" /> Share</span></div>
    <div className="zk-disclosure-line"><span>Amount</span><span><Icon name="lock" /> Optional</span></div>
    <div className="zk-disclosure-line"><span>Full financial record</span><span><Icon name="lock" /> Private</span></div>
    <div className="zk-screen-footer"><span>Choose what a verifier can see.</span></div>
  </div>;
}

export function HowItWorks() {
  const [active, setActive] = useState(0);
  const refs = useRef([]);
  const onKeyDown = (event, index) => {
    let next;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % steps.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + steps.length - 1) % steps.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = steps.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  };
  return <section id="workflow" className="zk-extension zk-workflow section bg-off-white" aria-labelledby="zk-workflow-title">
    <div className="zk-extension-grid">
      <SectionHead number="02 /" label={<>How it works<br /><span>From assets to action</span></>} title={<span id="zk-workflow-title">A clear path.<br />A private balance.</span>} description="Four deliberate steps. Every action stays connected to the same workspace." />
      <div className="zk-workflow-tabs" role="tablist" aria-label="How ZKdesk works" aria-orientation="vertical">
        {steps.map((step, index) => <button type="button" key={step.title} ref={(el) => { refs.current[index] = el; }} className={`zk-workflow-tab ${active === index ? 'is-active' : ''}`} id={`zk-workflow-tab-${index}`} role="tab" aria-selected={active === index} aria-controls={`zk-workflow-panel-${index}`} tabIndex={active === index ? 0 : -1} onClick={() => setActive(index)} onKeyDown={(event) => onKeyDown(event, index)}>
          <span className="zk-step-number">0{index + 1}</span><span><strong>{step.title}</strong><span className="zk-step-copy">{step.copy}</span></span><span className="zk-step-arrow"><Icon /></span>
        </button>)}
      </div>
      {steps.map((step, index) => <div className="zk-workflow-preview" role="tabpanel" key={step.label} id={`zk-workflow-panel-${index}`} aria-labelledby={`zk-workflow-tab-${index}`} tabIndex="0" hidden={active !== index}>
        <div className="zk-preview-orbit" aria-hidden="true" />
        <div className="zk-glass-card zk-preview-card">
          <div className="zk-preview-card-top"><span><Icon name={step.icon} />{step.label}</span><span>0{index + 1} <i>/ 04</i></span></div>
          <WorkflowPreview index={index} />
          <p className="zk-preview-caption">{step.summary}</p>
        </div>
        <div className="zk-preview-pagination" aria-hidden="true">{steps.map((item, itemIndex) => <span className={index === itemIndex ? 'is-active' : ''} key={item.label} />)}</div>
      </div>)}
      <a className="zk-text-link zk-workflow-link" href="/dashboard"><span>Open the workspace</span><span className="zk-link-arrow"><Icon /></span></a>
    </div>
  </section>;
}

const phases = [
  { number: '01', status: 'Live', title: 'Confidential foundation', description: 'Shielded asset notes, selective disclosure, and solvency proof infrastructure.', details: ['Confidential asset ledger', 'Scoped disclosure and view keys', 'Solvency proof infrastructure'], icon: 'lock' },
  { number: '02', status: 'Live', title: 'Private credit', description: 'Tokenized-stock collateral, USDG borrowing, private lender shares, and sealed liquidation batches.', details: ['Supported Stock Token collateral', 'USDG credit and lender shares', 'Sealed liquidation batches'], icon: 'credit' },
  { number: '03', status: 'Live', title: 'Treasury controls', description: 'Role-based ledgers, supported vault allocations, and treasury attestations.', details: ['Owner, treasurer, payer and auditor roles', 'Supported vault allocations', 'Treasury attestations'], icon: 'treasury' },
  { number: '04', status: 'Live', title: 'Payments and receipts', description: 'Bounded payroll and invoice mandates with selectively disclosable payment receipts.', details: ['Revocable payment mandates', 'Payroll and invoice schedules', 'Selectively disclosable receipts'], icon: 'payment' },
  { number: '05', status: 'Planned', title: 'Broader asset support', description: 'Registered treasury assets, cross-ledger netting, and collateral-swap integrations.', details: ['Registered treasury tokens', 'Cross-ledger netting', 'Collateral-swap integrations'], icon: 'proof' },
];

export function RoadmapSection() {
  return <section id="roadmap" className="zk-extension zk-roadmap section bg-off-white" aria-labelledby="zk-roadmap-title">
    <div className="zk-extension-grid">
      <SectionHead number="03 /" label={<>The roadmap<br /><span>Live and planned</span></>} title={<span id="zk-roadmap-title">Built layer by layer.<br />With privacy at the foundation.</span>} description="Phases one to four are live on Robinhood Chain mainnet. Phase five is planned." />
      <div className="zk-roadmap-track">
        {phases.map((phase, index) => <details className="zk-roadmap-phase" key={phase.number} open={index === 0 ? true : undefined}>
          <summary><span className="zk-phase-number">{phase.number}</span><span className="zk-phase-title"><span>{phase.title}</span><small>{phase.status}</small></span><span className="zk-phase-icon"><Icon name={phase.icon} /></span><span className="zk-disclosure-toggle"><Icon name="plus" /></span></summary>
          <div className="zk-phase-body"><p>{phase.description}</p><ul>{phase.details.map((detail) => <li key={detail}><span />{detail}</li>)}</ul></div>
        </details>)}
      </div>
      <p className="zk-section-note zk-roadmap-note">Relative phases <span>Scope may evolve as the protocol develops.</span></p>
    </div>
  </section>;
}

const questions = [
  ['What is ZKdesk?', 'ZKdesk is a confidential workspace for collateralized credit, treasury management, and business payments, live on Robinhood Chain mainnet. The protocol has not yet been independently audited.'],
  ['What stays private?', 'Your keys never leave your browser, and balances, transfer amounts and counterparties stay confidential. Deposits, withdrawals and credit step amounts are public, and the desk operator can read loan positions. The documentation lists exactly who sees what.'],
  ['Can an auditor see our records?', 'The role model includes a view-only auditor key. Scoped disclosure allows authorized parties to inspect the information they need, without granting permission to move funds.'],
  ['How do payment permissions work?', 'Mandates define a recipient, asset, spending cap, schedule, and expiry. They can be revoked, and each period can be paid only once.'],
  ['Can I prove I received a payment?', 'The receipt design supports a proof to a chosen verifier, with optional amount disclosure. Recipients generate the proof from the Activity view in the dashboard.'],
  ['Which assets are supported?', 'USDG, with SPY, QQQ, NVDA, and TSLA Stock Tokens as collateral. Registered treasury tokens are part of a later expansion. Stock Tokens carry their own eligibility and transfer rules.'],
];

export function QuestionsSection() {
  return <section id="questions" className="zk-extension zk-questions section bg-off-white" aria-labelledby="zk-questions-title">
    <div className="zk-extension-grid">
      <div className="zk-questions-head"><p className="zk-section-label">A little more clarity</p><h2 id="zk-questions-title">Good questions.<br />Clear answers.</h2><a className="zk-text-link" href="/dashboard"><span>Open the workspace</span><span className="zk-link-arrow"><Icon /></span></a></div>
      <div className="zk-questions-list">{questions.map(([question, answer], index) => <details className="zk-question" key={question}><summary><span className="zk-question-index">0{index + 1}</span><span>{question}</span><span className="zk-disclosure-toggle"><Icon name="plus" /></span></summary><p>{answer}</p></details>)}</div>
    </div>
  </section>;
}
