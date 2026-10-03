import React, { useEffect, useRef, useState } from 'react';
import { can, csvCell, distributionPercentages, futureDate, initialState, LTV, payable, receiptDisclosure, ROLES, STORAGE_KEY, today, totals, VIEWS } from './model.js';
import adapter from './adapters/index.js';
import { rekeyStepCount as rekeySteps } from '../lib/zk/rekey-steps.js';
import './dashboard.css';
import { ZMark } from '../brand/identity.jsx';
import { SoundToggle } from '../InteractionSound.jsx';
import qrcode from 'qrcode-generator';
import { paymentLink, readPaymentLink } from '../lib/zk/request-link.js';

const TESTNET = adapter.mode === 'testnet'; // the live adapter (mainnet or testnet); false in the demo
// Live-only styles load as their own chunk, so the demo CSS bundle stays byte-identical.
if (TESTNET) import('./live.css');
// The live adapter's network: names and symbols differ between mainnet (real assets) and testnet.
const NET = adapter.net ?? { mainnet: false, usd: 'tUSDG', name: 'Robinhood Chain testnet', t: 't', label: 'Testnet' };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** Testnet copy for a position's health line (computed from the private note, never published). */
/** Health bands: 1 is the liquidation threshold; below 0.95 a sale repays the whole position. */
function healthBand(h) {
  if (h < 1) return { tone: 'danger', label: 'Liquidatable' };
  if (h < 1.25) return { tone: 'warn', label: 'At risk' };
  if (h < 1.6) return { tone: 'watch', label: 'Watch' };
  return { tone: 'safe', label: 'Safe' };
}
const usd2 = (x) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Live health of one position: a bar against the threshold and the price at which it is liquidated. */
function HealthGauge({ position, masked }) {
  const h = position.health;
  const band = healthBand(h);
  const scale = 3; // the bar spans health 0 to 3; the threshold sits at a third
  const liquidation = position.mark / h; // health is linear in the price
  const drop = (1 - liquidation / position.mark) * 100;
  const asset = `${NET.t}${position.asset}`;
  return <div className={`desk-health ${band.tone}`} role="group" aria-label={`Position health ${masked ? 'hidden' : h.toFixed(2)}, ${band.label}`}>
    <div className="desk-health-head"><span>Health</span><strong>{masked ? '••' : h.toFixed(2)}</strong><em>{band.label}</em></div>
    <div className="desk-health-track" aria-hidden="true"><span style={{ width: `${Math.min(h / scale, 1) * 100}%` }} /><i style={{ left: `${100 / scale}%` }} title="Liquidation threshold" /></div>
    <div className="desk-health-prices"><span>{asset} now <strong>{masked ? '••' : usd2(position.mark)}</strong></span><span>Liquidation price <strong>{masked ? '••' : usd2(liquidation)}</strong>{!masked && <small>{h >= 1 ? ` · ${drop.toFixed(1)}% below` : ' · the price is below it'}</small>}</span></div>
  </div>;
}

function healthNote(position, desk) {
  if (position.liquidatedSold) return `Sealed batch sold ${position.liquidatedSold.toFixed(4)} ${NET.t}${position.asset} at a uniform price to repay credit. The rest remains yours.`;
  if (position.health === null) return 'No credit outstanding. Close to take the collateral back.';
  const status = position.health < 1 ? 'Eligible for the next sealed batch.' : 'Private health at the pinned mark.';
  return `${status}${desk?.epoch ? ` Desk epoch #${desk.epoch} at ${clock(desk.attestedAt)}.` : ''}`;
}
function deskNote(desk) {
  if (!desk?.epoch) return 'Awaiting the first desk health epoch. Each epoch proves the totals over every position; only the totals are public.';
  return `Desk health epoch #${desk.epoch} proven at ${clock(desk.attestedAt)}: collateral and credit totals over every position, with no position revealed. ${desk.healthy ? 'New credit is open.' : 'The epoch is overdue, so new credit is paused. Repaying and closing still work.'}`;
}
const COPY = TESTNET
  ? { eyebrow: `ZKdesk · ${NET.label} workspace`, review: 'Review', confirm: 'Confirm', working: 'Working…', reviewNote: NET.mainnet ? 'This submits a real transaction on Robinhood Chain with real funds. The zero-knowledge proof is generated in your browser.' : 'This submits a real transaction on Robinhood Chain testnet with test assets. The zero-knowledge proof is generated in your browser.', formNote: NET.mainnet ? 'Robinhood Chain mainnet · real assets.' : 'Robinhood Chain testnet · test assets only.', done: `Confirmed on ${NET.name}.`, workspace: `${NET.label} workspace`, workspaceSub: NET.name, badge: `${NET.label} workspace`, footer: NET.mainnet ? 'Real assets · Robinhood Chain' : 'Test assets · Robinhood Chain testnet', title: `ZKdesk — ${NET.label} workspace`, total: 'Total private assets', recordKind: NET.name }
  : { eyebrow: 'ZKdesk · Demo workspace', review: 'Review simulation', confirm: 'Confirm simulation', working: 'Working…', reviewNote: null, formNote: 'A local simulation. No wallet or production service is connected.', done: 'Simulation complete. Your demo workspace is updated.', workspace: 'Demo workspace', workspaceSub: 'Local product preview', badge: 'Demo workspace', footer: 'Sample data · Stored locally in this browser', title: 'ZKdesk — Demo workspace', total: 'Total sample assets', recordKind: null };
const short = (value) => (value && value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value);
const LABELS = { overview: 'Overview', credit: 'Credit', treasury: 'Treasury', payments: 'Payments', activity: 'Activity', settings: 'Settings', transparency: 'Transparency' };
// Testnet adds a public Transparency view (no wallet needed); the demo keeps its six views.
const NAV = TESTNET ? [...VIEWS.slice(0, 5), 'transparency', VIEWS[5]] : VIEWS;
const ICONS = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  credit: 'M4 18V8m5 10V4m5 14v-7m5 7V6 M2 21h20',
  treasury: 'M3 8l9-5 9 5 M4 9h16 M6 10v8m6-8v8m6-8v8 M3 21h18 M4 18h16',
  payments: 'M4 7h14m-4-4 4 4-4 4 M20 17H6m4-4-4 4 4 4',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M4 6h16M4 12h16M4 18h16 M8 3v6m8 0v6m-6 0v6',
  arrow: 'M5 12h14m-6-6 6 6-6 6', plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M6 18 18 6', down: 'M6 9l6 6 6-6',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  lock: 'M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
  check: 'M5 12l4 4L19 6', export: 'M12 3v12m-4-4 4 4 4-4 M4 15v6h16v-6',
  back: 'M19 12H5m6-6-6 6 6 6', menu: 'M4 6h16M4 12h16M4 18h16',
  shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z M8 12l3 3 5-6',
  transparency: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z M8 12l3 3 5-6',
};
function Icon({ name, size = 18 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name] || ICONS.overview} /></svg>; }
const ROLE_NOTES = { Owner: 'Full control · approves large transfers', Treasurer: 'Adds, allocates and moves funds', Payer: 'Sends, withdraws and pays mandates', Auditor: 'Views everything · cannot move funds' };
/** Live top-bar role picker: a styled listbox (the native select menu cannot be styled). */
function RoleMenu({ value, options, personal, onChange }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef(null);
  const single = options.length < 2;
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const show = () => { setActive(Math.max(0, options.indexOf(value))); setOpen(true); };
  const pick = (role) => { setOpen(false); if (role !== value) onChange(role); root.current?.querySelector('button')?.focus(); };
  const key = (e) => {
    if (single) return;
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); return; }
    if (!open) return;
    if (e.key === 'Escape' || e.key === 'Tab') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % options.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + options.length) % options.length); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(options[active]); }
  };
  return <div className={`desk-role-menu ${open ? 'open' : ''}`} ref={root} onKeyDown={key}>
    <button type="button" className="desk-role-pill" aria-haspopup="listbox" aria-expanded={open} aria-label={`Acting role: ${value}`} disabled={single} title={single ? (personal ? 'Your personal account: you own every note.' : 'The only role you hold in this treasury.') : undefined} onClick={() => (open ? setOpen(false) : show())}>
      <span className="desk-role-pill-label" aria-hidden="true">Role</span><span className="desk-role-pill-value">{value}</span>{!single && <Icon name="down" size={12} />}
    </button>
    {open && <ul className="desk-role-list" role="listbox" aria-label="Acting role" aria-activedescendant={`desk-role-${options[active]}`}>
      <li className="desk-role-list-head" role="presentation">{personal ? 'Acting role' : 'Your roles in this treasury'}</li>
      {options.map((role, i) => <li key={role} id={`desk-role-${role}`} role="option" aria-selected={role === value} className={`${i === active ? 'active' : ''} ${role === value ? 'selected' : ''}`} onPointerEnter={() => setActive(i)} onClick={() => pick(role)}>
        <span><strong>{role}</strong><small>{ROLE_NOTES[role] ?? ''}</small></span>{role === value && <Icon name="check" size={14} />}
      </li>)}
    </ul>}
  </div>;
}
function Button({ children, variant = '', className = '', icon, ...props }) { return <button className={`desk-button ${variant} ${className}`} {...props}>{icon && <Icon name={icon} size={15} />}{children}</button>; }
function Badge({ children, tone = '' }) { return <span className={`desk-badge ${tone}`}>{children}</span>; }
function Empty({ title, detail, action, onAction }) { return <div className="desk-empty"><span className="desk-empty-icon"><Icon name="overview" size={24} /></span><h3>{title}</h3><p>{detail}</p>{action && <Button onClick={onAction}>{action}</Button>}</div>; }
function getView() { const view = new URLSearchParams(window.location.search).get('view'); return NAV.includes(view) ? view : 'overview'; }
function date(value) { return new Date(value).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }); }
function when(value) { return new Date(value).toLocaleString('en', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }); }
// The agent's access end (v3.5), as the agent form sets it.
const ACCESS_LABELS = { none: 'No end', '1h': '1 hour from now', '24h': '24 hours from now', '7d': '7 days from now', '30d': '30 days from now' };
// Moving a treasury to new keys (3.21): the review.
const amountText = (x) => `${x.amount.toLocaleString('en', { maximumFractionDigits: 6 })} ${x.symbol}`;
function rekeyRows(values, ledger, money) {
  const r = ledger?.rekey;
  if (!r) return [];
  const moves = r.moves.length ? r.moves.map(amountText).join(', ') : 'Nothing at the moment';
  const carried = r.mandates.filter((m) => m.continued || (m.carryable && values.carry.includes(m.id)));
  const dropped = r.mandates.length - carried.length;
  const steps = rekeySteps(r, values.carry);
  const left = [
    ...(r.dust ? [['Left behind', `${r.dust} note${r.dust > 1 ? 's' : ''} worth less than the fee to move ${r.dust > 1 ? 'them' : 'it'}`]] : []),
    ...(r.pending ? [['Still clearing', `${r.pending} deposit${r.pending > 1 ? 's' : ''}: move ${r.pending > 1 ? 'them' : 'it'} later with Move remaining funds`]] : []),
  ];
  const mandateRows = r.mandates.length ? [['Mandates continued', carried.length ? carried.map((m) => m.label || 'Mandate').join(', ') + ', from the period after the last one paid' : 'None'], ...(dropped ? [['Mandates revoked', String(dropped)]] : [])] : [];
  const fees = [['Relay fees', r.stepCost === null ? 'Could not be read right now' : `About ${money(steps * r.stepCost)} for ${steps} step${steps === 1 ? '' : 's'}, from your personal balance. Keep this tab open until it finishes.`]];
  if (r.movedTo) return [['Treasury', ledger.name], ['New treasury', 'Already created: this continues the move'], ['To move', moves], ...left, ...mandateRows, ...fees];
  const payer = values.payer.trim();
  const sameAgent = payer && r.agentKey && payer.toLowerCase().slice(4, 68) === r.agentKey.slice(2);
  return [
    ['Treasury', ledger.name], ['New treasury', `${ledger.name.replace(/ \(new keys\)$/, '')} (new keys), with a new zkd: address`],
    ['Agent (Payer)', payer ? `${payer.toLowerCase() === r.schedulerAddress?.toLowerCase() ? 'ZKdesk scheduler' : short(payer)}${sameAgent ? ' · the current agent: it keeps access' : ''}` : 'You · no agent'],
    ...(payer ? [['Agent access ends', endsLabel(values, ledger.scope)]] : []),
    ['Treasurer', short(values.treasurer.trim()) || 'You'], ['Auditor', short(values.auditor.trim()) || 'You'],
    ['To move', moves], ...left, ...mandateRows,
    ['Carried over', `Approval threshold, allocation cap, payments-without-approval limit${payer ? ", the agent's allowed recipients and budget" : ''}`],
    ['Not carried over', "Pending approval requests and solvency statements. The agent's budget for this period starts from zero."],
    ['This treasury', 'Its roles go back to you first. It keeps its history, and anyone who held its keys can still read that.'],
    ['Old keys', 'Cannot read the new treasury. They see this treasury empty out.'],
    ...fees,
  ];
}
function endsLabel(values, scope) {
  if (values.ends === 'keep') return scope?.ends ? `${scope.ended ? 'Ended' : 'Unchanged'} · ${when(scope.ends)}` : 'No end';
  if (values.ends === '') return 'Choose';
  if (values.ends === 'date') return Number.isFinite(Date.parse(values.endsOn)) ? when(Date.parse(values.endsOn)) : 'Pick a date';
  return ACCESS_LABELS[values.ends] ?? 'No end';
}
function exportRecord(record) {
  const blob = new Blob([JSON.stringify(TESTNET ? { environment: NET.name, ...record } : { environment: 'ZKdesk local demonstration', onChain: false, zkProof: null, ...record }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `zkdesk-${TESTNET ? '' : 'demo-'}${record.receipt || record.id || 'record'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Payment request links open the dashboard with a private send prefilled. Nothing is posted anywhere:
 * the link carries the recipient's private address, an optional amount and an optional note. */
const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
function requestLink({ to, amount, memo }) {
  const url = paymentLink(window.location.origin, { to, amount, memo, network: NET.mainnet ? 'mainnet' : 'testnet' });
  const mode = new URLSearchParams(window.location.search).get('mode'); // a ?mode= override travels with the link
  if (mode) url.searchParams.set('mode', mode);
  return url.toString();
}
function readRequest() {
  if (!TESTNET) return null;
  const r = readPaymentLink(new URLSearchParams(window.location.search));
  return r && { to: r.to, amount: r.amount, memo: r.memo };
}
/** A QR code drawn as one SVG path (no images, so the page CSP is unchanged). */
function QrCode({ text, size = 200 }) {
  const qr = qrcode(0, 'L'); // low error correction: fewer, larger modules for a long URL on a screen
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
  return <svg className="desk-qr" viewBox={`-3 -3 ${n + 6} ${n + 6}`} width={size} height={size} role="img" aria-label="QR code of the payment link" shapeRendering="crispEdges"><rect x="-3" y="-3" width={n + 6} height={n + 6} fill="#fff" /><path d={d} fill="#1d2733" /></svg>;
}
function RequestDialog({ state, onClose, onCopied }) {
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const valid = amount === '' || (AMOUNT.test(amount) && Number(amount) > 0);
  const treasury = state.meta?.workspace && state.meta.workspace !== 'personal';
  const link = valid && state.meta?.zkAddress ? requestLink({ to: state.meta.zkAddress, amount, memo: memo.trim() }) : '';
  const copy = () => { navigator.clipboard?.writeText(link); onCopied('Payment link copied.'); };
  const share = () => navigator.share?.({ title: 'ZKdesk payment request', text: memo.trim() || 'Pay me privately on ZKdesk', url: link }).catch(() => {});
  return <Modal title="Request a private payment" onClose={onClose}>
    <p className="desk-dialog-copy">Share this link or QR code. It opens ZKdesk with a private send to {treasury ? `the ${state.meta.workspaceName || 'treasury'} treasury` : 'you'} filled in; the payer reviews and confirms. Nothing about the request is posted anywhere, and the payment itself stays private.</p>
    <div className="desk-form-fields">
      <label className="desk-field"><span>Amount · {NET.usd} (optional)</span><input type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="Payer chooses" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!valid} />{!valid && <small className="desk-field-error">Enter an amount above zero, with up to 6 decimals.</small>}</label>
      <label className="desk-field"><span>Note for the payer (optional)</span><input type="text" maxLength={60} placeholder="e.g. Invoice 1042" value={memo} onChange={(e) => setMemo(e.target.value)} autoComplete="off" /><small>The note travels in the link only; it is not stored or sent on-chain.</small></label>
    </div>
    {link && <div className="desk-request"><QrCode text={link} /><div className="desk-request-link"><code>{link}</code><div className="desk-request-actions"><Button variant="primary" onClick={copy}>Copy link</Button>{typeof navigator.share === 'function' && <Button onClick={share}>Share</Button>}</div><small>Anyone with this link sees your private address{amount ? ', the amount' : ''}{memo.trim() ? ' and the note' : ''}. Your balance stays private.</small></div></div>}
  </Modal>;
}

/** The 24 recovery words of a passkey account, numbered in reading order. */
function RecoveryWords({ words }) {
  return <ol className="desk-recovery-words" aria-label="Recovery key, 24 words in order">{words.map((w, i) => <li key={i}><span>{i + 1}</span>{w}</li>)}</ol>;
}
const RECOVERY_WARNING = 'Anyone with these words can spend your private funds. Write them down and keep them offline. ZKdesk never stores them and cannot recover them for you.';

/** Unlock with a passkey: an existing one, a new one (recovery key first), or the recovery words. */
function PasskeyDialog({ onClose, onDone }) {
  const [step, setStep] = useState('choose'); // choose | words | restore
  const [supported, setSupported] = useState(true);
  const [created, setCreated] = useState(null); // { seed, id } of a new passkey
  const [saved, setSaved] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { adapter.passkey.supported().then(setSupported, () => setSupported(false)); }, []);
  const run = (label, fn) => async () => {
    setError(''); setBusy(label);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const unlock = run('Waiting for your passkey…', async () => { await adapter.passkey.unlock(); onDone('Passkey accepted. Your private notes are unlocked.'); });
  const create = run('Creating your passkey…', async () => { setCreated(await adapter.passkey.create()); setStep('words'); });
  const finish = run('Opening your account…', async () => { await adapter.passkey.open(created); onDone('Passkey created. Your private account is ready.'); });
  const restore = run('Opening your account…', async () => {
    const seed = adapter.passkey.fromWords(text);
    if (!seed) throw new Error('Those words are not a ZKdesk recovery key. Check each word and their order.');
    await adapter.passkey.open({ seed });
    onDone('Recovery key accepted. Your private notes are unlocked.');
  });
  const errorLine = error && <p role="alert" className="desk-form-error">{error}</p>;
  if (step === 'words') return <Modal title="Save your recovery key." onClose={onClose}>
    <p className="desk-dialog-copy">If this passkey is ever deleted or lost, these 24 words are the only way back into this account. Write them down in order before you continue.</p>
    <RecoveryWords words={adapter.passkey.words(created.seed)} />
    <div className="desk-callout"><Icon name="lock" /><p>{RECOVERY_WARNING}</p></div>
    <fieldset className="desk-disclosure-options"><legend>Confirm</legend><label><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /><span>I have written down all 24 words, in order.</span></label></fieldset>
    {errorLine}
    <div className="desk-dialog-actions"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!saved || Boolean(busy)} aria-busy={Boolean(busy)} onClick={finish}>{busy || 'Open my account'}{!busy && <Icon name="arrow" size={15} />}</Button></div>
  </Modal>;
  if (step === 'restore') return <Modal title="Restore with your recovery key." onClose={onClose}>
    <p className="desk-dialog-copy">Enter the 24 words you saved when you created your passkey, in order. They open the same private account; nothing is sent anywhere.</p>
    <label className="desk-field"><span>Recovery key · 24 words</span><textarea className="desk-recovery-input" rows={4} value={text} onChange={(e) => { setText(e.target.value); setError(''); }} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="word1 word2 word3 …" /></label>
    {errorLine}
    <div className="desk-dialog-actions"><Button onClick={() => { setStep('choose'); setError(''); }}>Back</Button><Button variant="primary" disabled={Boolean(busy)} aria-busy={Boolean(busy)} onClick={restore}>{busy || 'Unlock'}{!busy && <Icon name="arrow" size={15} />}</Button></div>
  </Modal>;
  return <Modal title="Unlock with a passkey." onClose={onClose}>
    <p className="desk-dialog-copy">Use Face ID, Touch ID, Windows Hello or a security key instead of a wallet signature. The same passkey opens the same private account on every device it syncs to. MetaMask is only asked for when you add funds.</p>
    {!supported && <div className="desk-callout"><Icon name="lock" /><p>This browser reports no passkey support for ZKdesk (WebAuthn PRF). Use a current Chrome, Edge or Safari, connect MetaMask, or restore with your recovery key.</p></div>}
    {errorLine}
    <div className="desk-dialog-actions desk-passkey-actions"><Button variant="text" onClick={() => { setStep('restore'); setError(''); }}>Use recovery key</Button><Button disabled={!supported || Boolean(busy)} onClick={create}>Create a passkey</Button><Button variant="primary" disabled={!supported || Boolean(busy)} aria-busy={Boolean(busy)} onClick={unlock}>{busy || 'Unlock with my passkey'}</Button></div>
  </Modal>;
}

/** Shows the open passkey account's recovery words again (asks the passkey; nothing is stored). */
function RecoveryDialog({ onClose }) {
  const [words, setWords] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const show = async () => { setError(''); setBusy('Waiting for your passkey…'); try { setWords(await adapter.passkey.recovery()); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  return <Modal title="Your recovery key." onClose={onClose}>
    <p className="desk-dialog-copy">The 24 words that restore this account if your passkey is lost. Your passkey is asked to confirm it is you.</p>
    {words && <RecoveryWords words={words} />}
    <div className="desk-callout"><Icon name="lock" /><p>{RECOVERY_WARNING}</p></div>
    {error && <p role="alert" className="desk-form-error">{error}</p>}
    <div className="desk-dialog-actions"><Button onClick={onClose}>Done</Button>{!words && <Button variant="primary" disabled={Boolean(busy)} aria-busy={Boolean(busy)} onClick={show}>{busy || 'Show recovery key'}</Button>}</div>
  </Modal>;
}

function Modal({ title, children, onClose }) {
  const panel = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const background = [...document.querySelectorAll('.desk-sidebar, .desk-main')].map((element) => ({ element, inert: element.inert }));
    background.forEach(({ element }) => { element.inert = true; });
    document.body.style.overflow = 'hidden';
    const focusable = () => [...panel.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')];
    const frame = requestAnimationFrame(() => (focusable().find((el) => el.tagName === 'INPUT') || focusable()[0] || panel.current)?.focus());
    const keydown = (event) => {
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const items = focusable(); const first = items[0]; const last = items.at(-1);
        if (!panel.current.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = previousOverflow; background.forEach(({ element, inert }) => { element.inert = inert; }); document.removeEventListener('keydown', keydown); requestAnimationFrame(() => { (previous?.isConnected && !previous.disabled && !previous.closest('[inert]') ? previous : document.querySelector('.desk-view-toolbar .desk-button:not(:disabled), .desk-nav-item.active'))?.focus?.(); }); };
  }, []);
  return <div className="desk-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="desk-modal" role="dialog" aria-modal="true" aria-labelledby="desk-dialog-title" tabIndex={-1} ref={panel}><div className="desk-modal-heading"><span className="desk-eyebrow">{COPY.eyebrow}</span><button className="desk-icon-button" onClick={onClose} aria-label="Close dialog"><Icon name="close" /></button><h2 id="desk-dialog-title">{title}</h2></div>{children}</section></div>;
}

const ACTION_TITLES = { open: 'Open private credit', repay: 'Repay credit', add: 'Add collateral', close: 'Close position', deposit: 'Add sample USDG', allocate: 'Allocate treasury funds', deallocate: 'Move funds to liquid', mandate: 'Create payment mandate', pay: 'Simulate a payment', pause: 'Pause mandate', resume: 'Resume mandate', revoke: 'Revoke mandate', send: 'Send privately', withdraw: 'Withdraw to a wallet' };
const allowCount = (text) => String(text ?? '').split(/[\s,]+/).filter(Boolean).length;
const TITLES = TESTNET ? { ...ACTION_TITLES, deposit: 'Add private funds', allocate: 'Supply to the credit pool', deallocate: 'Withdraw from the credit pool', ledger: 'Set up a treasury', roles: 'Manage treasury roles', attest: 'Prove treasury solvency', pay: 'Pay under this mandate', approve: 'Approve a treasury transfer', decline: 'Decline a treasury transfer', complete: 'Complete an approved transfer', combine: 'Combine private notes', agent: 'Add an AI agent', unagent: 'Remove the AI agent', rekey: 'Move to new keys' } : ACTION_TITLES;
const LEDGER_TITLES = { deposit: 'Add funds to the treasury', allocate: 'Allocate to the yield vault', deallocate: 'Move from the yield vault', send: 'Pay from the treasury', withdraw: 'Withdraw from the treasury' };
const titleOf = (type, state) => (state.meta?.ledger && LEDGER_TITLES[type]) || TITLES[type];
const ROLE_FIELDS = [['treasurer', 'Treasurer'], ['payer', 'Payer'], ['auditor', 'Auditor']];
function ActionDialog({ action, state, onClose, onConfirm, money }) {
  const position = state.positions.find((item) => item.id === action.id);
  const mandate = state.mandates.find((item) => item.id === action.id);
  const [values, setValues] = useState({ id: action.id, asset: TESTNET && ['deposit', 'mandate'].includes(action.type) ? 'USDG' : 'SPY', collateral: '', amount: action.amount ?? (action.type === 'pay' ? String(mandate?.cap || '') : ''), kind: action.kind || 'Payroll', recipient: action.recipient ?? (action.type === 'withdraw' ? (state.meta?.address || '') : ''), cap: action.type === 'roles' ? String(state.meta?.ledger?.allocCap ?? '') : '', period: 'Monthly', expiry: futureDate(90), reference: '', name: '', treasurer: '', payer: '', auditor: '', threshold: ['roles', 'agent'].includes(action.type) ? String(state.meta?.ledger?.dualThreshold ?? '') : '', limit: String(state.meta?.ledger?.limit?.max ?? ''), per: state.meta?.ledger?.limit?.days === 7 ? 'week' : 'day', allowTo: (state.meta?.ledger?.scope?.allowTo ?? []).join('\n'), budget: String(state.meta?.ledger?.scope?.budget ?? ''), budgetPer: state.meta?.ledger?.scope?.per ?? 'day', ends: state.meta?.ledger?.scope?.ends ? (state.meta.ledger.scope.ended ? '' : 'keep') : 'none', endsOn: '', carry: [], ...(action.type === 'rekey' && state.meta?.ledger?.scheduled ? { payer: state.meta.scheduler ?? '' } : {}) });
  const resumeMove = action.type === 'rekey' && Boolean(state.meta?.ledger?.rekey?.movedTo) && !state.meta.ledger.rekey.mandates.length;
  const [review, setReview] = useState(['close', 'pause', 'resume', 'revoke', 'approve', 'decline', 'complete', 'combine', 'unagent'].includes(action.type) || resumeMove);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState('');
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = review
        ? document.querySelector('.desk-modal [data-confirm-simulation]')
        : document.querySelector('.desk-modal input, .desk-modal select');
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [review]);
  const update = (key, value) => { setValues((old) => ({ ...old, [key]: value, ...(key === 'kind' && value === 'Invoice' ? { period: 'One-time' } : {}) })); setErrors((old) => ({ ...old, [key]: undefined, general: undefined })); };
  const field = (key, label, input, help) => <label className="desk-field" key={key}><span>{label}</span>{React.cloneElement(input, { value: values[key], onChange: (e) => update(key, e.target.value), id: `desk-field-${key}`, 'aria-invalid': Boolean(errors[key]), 'aria-describedby': errors[key] ? `error-${key}` : undefined })}{errors[key] ? <small className="desk-field-error" id={`error-${key}`}>{errors[key]}</small> : help && <small>{help}</small>}</label>;
  const amountField = (label = 'Amount · USDG', help) => field('amount', label, <input type="number" inputMode="decimal" min="0.01" max="1000000000" step="0.01" placeholder="0.00" />, help);
  const validate = (event) => { event.preventDefault(); const found = adapter.validate(state, action.type, values); setErrors(found); if (!Object.keys(found).length) setReview(true); else document.getElementById(`desk-field-${Object.keys(found)[0]}`)?.focus(); };
  const confirm = async () => {
    if (busy) return;
    const found = adapter.validate(state, action.type, values); setErrors(found);
    if (!Object.keys(found).length) { setBusy(COPY.working); try { await onConfirm(action.type, values, setBusy); } catch (error) { setErrors({ general: error.shortMessage || error.message }); } finally { setBusy(''); } }
  };
  const unit = TESTNET && action.type === 'deposit' ? (values.asset === 'USDG' ? NET.usd : `${NET.t}${values.asset} tokens`) : TESTNET && action.type === 'add' ? `${NET.t}${position?.asset} tokens` : null;
  const unitHelp = TESTNET && action.type === 'add' ? `You hold ${state.meta?.stockBalances?.[position?.asset] ?? 0} private ${NET.t}${position?.asset}.` : TESTNET && action.type === 'deposit' ? (NET.mainnet ? 'The tokens come from your wallet. The deposit clears after a short screening standby.' : 'Test tokens come from the faucet. The deposit clears after a short screening standby.') : TESTNET && state.meta?.ledger && action.type === 'allocate' ? `Yield vault · ${NET.mainnet ? 'Morpho USDG vault, variable yield' : 'test NAV accrues at 4% a year'}. Policy cap per allocation: ${money(state.meta.ledger.allocCap)}.` : TESTNET && state.meta?.ledger && action.type === 'deallocate' ? 'From the yield vault back to liquid treasury USDG.' : TESTNET && ['allocate', 'deallocate'].includes(action.type) ? `Credit pool: ${money(state.meta?.liquidity)} available to borrow or withdraw.` : null;
  const collValue = Number(values.collateral) * (TESTNET ? state.meta?.marks?.[values.asset] ?? 0 : 1);
  const rows = action.type === 'open' ? [['Collateral asset', values.asset], [TESTNET ? 'Collateral' : 'Sample collateral value', TESTNET ? `${values.collateral} ${NET.t}${values.asset} ≈ ${money(collValue)}` : money(Number(values.collateral))], ['USDG to borrow', money(Number(values.amount))], ['Opening LTV', `${((Number(values.amount) / collValue || 0) * 100).toFixed(1)}%`]]
    : action.type === 'mandate' ? [['Type', values.kind], ['Recipient', TESTNET ? `${values.name || 'Unnamed'} · ${short(values.recipient)}` : values.recipient], ...(TESTNET ? [['Pay in', values.asset === 'USDG' ? NET.usd : `${NET.t}${values.asset} at the pinned mark`]] : []), ...(values.kind === 'Invoice' ? [['Invoice reference', values.reference]] : []), ['Payment cap', money(Number(values.cap))], ['Period', values.kind === 'Invoice' ? 'One-time' : values.period], ['Expires', date(values.expiry)]]
      : action.type === 'close' ? [['Position', position?.asset], ['Credit to repay', money(position?.debt)], ['Collateral returned', money(position?.collateral)]]
        : ['pause', 'resume', 'revoke'].includes(action.type) ? [['Recipient', mandate?.recipient], ['Current status', mandate?.status], ['New status', action.type === 'pause' ? 'Paused' : action.type === 'resume' ? 'Active' : 'Revoked']]
          : ['ledger', 'roles'].includes(action.type) ? [['Treasury', action.type === 'ledger' ? values.name : state.meta?.ledger?.name], ['Owner', action.type === 'ledger' ? 'You' : 'Unchanged'], ...ROLE_FIELDS.map(([k, label]) => [label, short(values[k].trim()) || (action.type === 'ledger' ? 'You' : 'Unchanged')]), ['Allocation cap', money(Number(values.cap))], ['Owner approval above', money(Number(values.threshold))], ...(action.type === 'roles' && values.payer.trim() && state.meta?.ledger?.scope ? [['Payer limits', 'Removed if this is a new Payer (set limits in Treasury → AI agent)']] : [])]
          : ['approve', 'decline', 'complete'].includes(action.type) ? (() => { const r = state.meta?.requests?.find((x) => x.id === action.id); return [['Amount', r?.symbol && r.symbol !== NET.usd ? `${r.amount} ${r.symbol}` : money(r?.amount)], ['To (check every character)', r?.toFull ?? r?.to], ['Requested by (as the request says; not verified)', r?.mine ? `You (${r?.role})` : r?.role], ['Requested', r ? date(r.at) : ''], ...(r?.status === 'Declined' ? [['Status', 'Marked declined (unverified: anyone holding the treasury keys can mark it)']] : [])]; })()
          : action.type === 'agent' ? [['Treasury', state.meta?.ledger?.name], ['Payer', `AI agent · ${short(values.recipient.trim())}`], ['Per payment', `Up to ${money(Number(values.threshold))} without your approval`], ['Payments without approval', values.limit === '' ? 'Unchanged' : Number(values.limit) ? `At most ${values.limit} per ${values.per}` : 'No limit'], ['Allowed recipients', allowCount(values.allowTo) ? `${allowCount(values.allowTo)} listed` : 'Anyone'], ['Budget', values.budget === '' ? 'No budget' : `${money(Number(values.budget))} per ${values.budgetPer}`], ['Access ends', endsLabel(values, state.meta?.ledger?.scope)], ['The agent can', values.ends === 'keep' && state.meta?.ledger?.scope?.ended ? 'Only pause mandates (its access has ended)' : `Pay mandates and send payments up to the per-payment limit${allowCount(values.allowTo) ? ', to listed recipients only' : ''}${values.budget === '' ? '' : ', within the budget'}`], ['The agent cannot', values.ends === 'keep' && state.meta?.ledger?.scope?.ended ? 'Pay at all, or create, resume or revoke mandates' : `Allocate, change roles, approve${allowCount(values.allowTo) || values.budget !== '' || values.ends !== 'none' ? ', create, resume or revoke mandates' : ''}, or pay above the per-payment limit without you`]]
          : action.type === 'unagent' ? [['Treasury', state.meta?.ledger?.name], ['Payer', 'You (the agent can no longer pay)'], ['Funds', 'Stay in the treasury'], ['Visibility', 'The agent keeps the viewing key it was given and can still read this treasury. To cut that off too, use Settings → Move to new keys.']]
          : action.type === 'rekey' ? rekeyRows(values, state.meta?.ledger, money)
          : action.type === 'attest' ? [['Treasury', state.meta?.ledger?.name], ['Declared liabilities', money(Number(values.amount))], ['Published', 'Only that the treasury covers this']]
          : action.type === 'combine' ? (() => { const n = state.meta?.combinable ?? 0; return [['USDG notes', String(n)], ['Private self-transfers', `${Math.max(n - 1, 0)}, one proof each`], ['Relay fees', `about ${money(Math.max(n - 1, 0) * (state.meta?.fee ?? 0))}`], ['Result', 'One note: any amount up to your balance can be sent in one step']]; })()
          : [[position ? 'Position' : mandate ? 'Recipient' : 'Asset', position?.asset || mandate?.recipient || (TESTNET && action.type === 'deposit' ? values.asset : 'USDG')], ['Amount', unit && unit !== NET.usd ? `${values.amount} ${unit}` : money(Number(values.amount))], ...(['send', 'withdraw'].includes(action.type) ? [['Recipient', short(values.recipient)]] : []), ...(action.memo ? [['Request note', action.memo]] : [])];
  return <Modal title={review ? COPY.review : titleOf(action.type, state)} onClose={busy && action.type === 'rekey' ? () => {} : onClose}>
    {review ? <><p className="desk-dialog-copy">{titleOf(action.type, state)}. {TESTNET ? 'Review the details before you confirm.' : 'Review the details before updating your local demo.'}</p><dl className="desk-review-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="desk-callout"><Icon name="lock" /><p>{action.type === 'decline' ? 'Posts a private note to the treasury mailbox. Nothing moves on-chain and no fee is paid; the request can still be approved later.' : COPY.reviewNote || <>No assets will move on-chain. This action changes sample data stored in this browser.{action.type === 'open' && ' Sample collateral is added from outside this workspace.'}{action.type === 'revoke' && ' A revoked mandate cannot be resumed.'}</>}</p></div>{errors.general && <p role="alert" className="desk-form-error">{errors.general}</p>}{errors.amount && <p role="alert" className="desk-form-error">{errors.amount}</p>}<div className="desk-dialog-actions"><Button disabled={Boolean(busy) && action.type === 'rekey'} onClick={() => ['close', 'pause', 'resume', 'revoke', 'approve', 'decline', 'complete', 'unagent'].includes(action.type) || resumeMove ? onClose() : setReview(false)}>Back</Button><Button variant={action.type === 'revoke' ? 'danger' : 'primary'} data-confirm-simulation="true" onClick={confirm} disabled={Boolean(busy)} aria-busy={Boolean(busy)}>{busy || COPY.confirm}{!busy && <Icon name="arrow" size={15} />}</Button></div></>
      : <form onSubmit={validate} noValidate><div className="desk-form-fields">
        {action.type === 'open' && <>{field('asset', 'Collateral asset', <select>{Object.keys(LTV).map((asset) => <option key={asset}>{asset}</option>)}</select>, TESTNET ? `Pinned price ${money(state.meta?.marks?.[values.asset])} · you hold ${state.meta?.stockBalances?.[values.asset] ?? 0} private ${NET.t}${values.asset}` : 'Specification values. No live market quote.')}{field('collateral', TESTNET ? `Collateral · ${NET.t}${values.asset} tokens` : 'Collateral value · sample USDG equivalent', <input type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00" />)}{amountField('USDG to borrow', `Maximum opening LTV: ${LTV[values.asset] * 100}%. ${TESTNET ? 'Rate from the public utilization curve.' : 'Pricing would follow the public rate curve.'}`)}<div className="desk-input-summary"><span>Maximum draw</span><strong>{money(Number(values.collateral || 0) * (TESTNET ? state.meta?.marks?.[values.asset] ?? 0 : 1) * LTV[values.asset])}</strong></div></>}
        {['send', 'withdraw'].includes(action.type) && field('recipient', action.type === 'send' ? 'Recipient ZKdesk address' : 'Recipient wallet address', <input type="text" maxLength={140} placeholder={action.type === 'send' ? 'zkd:…' : '0x…'} autoComplete="off" spellCheck={false} />, action.type === 'send' ? 'The recipient copies this from their Settings.' : 'Funds leave the private pool for this public address.')}
        {['deposit', 'allocate', 'deallocate', 'repay', 'add', 'pay', 'send', 'withdraw'].includes(action.type) && <>{TESTNET && action.type === 'deposit' && field('asset', 'Asset', <select><option value="USDG">{NET.usd}</option>{Object.keys(LTV).map((a) => <option key={a} value={a}>{NET.t}{a}</option>)}</select>)}{position && <div className="desk-input-summary"><span>{position.asset} position · outstanding credit</span><strong>{money(position.debt)}</strong></div>}{mandate && <div className="desk-input-summary"><span>{mandate.recipient}</span><strong>Cap {money(mandate.cap)}</strong></div>}{amountField(unit ? (action.type === 'add' ? `Collateral to add · ${unit}` : `Amount · ${unit}`) : action.type === 'add' ? 'Collateral to add · sample USDG equivalent' : 'Amount · USDG', unitHelp || (action.type === 'deallocate' ? `Allocated: ${money(state.vault)}` : action.type === 'add' ? 'Adds externally supplied sample collateral.' : `Liquid balance: ${money(state.cash)}`))}</>}
        {['ledger', 'roles'].includes(action.type) && <>{action.type === 'ledger' && field('name', 'Treasury name', <input type="text" maxLength={32} placeholder="e.g. Operations" autoComplete="off" />)}{ROLE_FIELDS.map(([k, label]) => field(k, `${label} · ZKdesk address`, <input type="text" maxLength={140} placeholder={action.type === 'ledger' ? 'zkd:… · blank: you' : 'zkd:… · blank: unchanged'} autoComplete="off" spellCheck={false} />, k === 'auditor' ? 'Members copy their private address from Settings. The Auditor can read, never move funds.' : undefined))}<div className="desk-field-pair">{field('cap', 'Allocation cap · USDG', <input type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00" />)}{field('threshold', 'Owner approval above · USDG', <input type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00" />)}</div></>}
        {action.type === 'rekey' && <>{!state.meta?.ledger?.rekey?.movedTo && <>{field('payer', 'Agent (Payer) · ZKdesk address · optional', <input type="text" maxLength={140} placeholder="zkd:… · blank: no agent" autoComplete="off" spellCheck={false} />, state.meta?.ledger?.scheduled ? 'The ZKdesk scheduler pays this treasury\'s mandates; it stays the Payer unless you change this.' : 'To replace a leaked agent key, give the agent a new seed and paste its new address.')}{values.payer.trim() && <div className="desk-field-pair">{field('ends', 'Agent access ends', <select>{state.meta?.ledger?.scope?.ended && <option value="" disabled>Choose…</option>}{state.meta?.ledger?.scope?.ends && !state.meta.ledger.scope.ended && <option value="keep">As now ({when(state.meta.ledger.scope.ends)})</option>}<option value="none">No end</option><option value="1h">In 1 hour</option><option value="24h">In 24 hours</option><option value="7d">In 7 days</option><option value="30d">In 30 days</option><option value="date">On a date…</option></select>)}{values.ends === 'date' && field('endsOn', 'Ends on', <input type="datetime-local" />)}</div>}{field('treasurer', 'Treasurer · ZKdesk address · optional', <input type="text" maxLength={140} placeholder="zkd:… · blank: you" autoComplete="off" spellCheck={false} />)}{field('auditor', 'Auditor · ZKdesk address · optional', <input type="text" maxLength={140} placeholder="zkd:… · blank: you" autoComplete="off" spellCheck={false} />, 'Only the people you name here get the new keys. Members copy their address from Settings.')}</>}{state.meta?.ledger?.rekey?.mandates.length > 0 && <fieldset className="desk-carry"><legend>Mandates to continue in the new treasury</legend><p>Tick only the ones you recognise and still want. The others are revoked.</p>{state.meta.ledger.rekey.mandates.map((m) => <label key={m.id}><input type="checkbox" disabled={!m.carryable || m.continued} checked={m.continued || values.carry.includes(m.id)} onChange={(e) => setValues({ ...values, carry: e.target.checked ? [...values.carry, m.id] : values.carry.filter((x) => x !== m.id) })} /><span><strong>{m.label || 'Mandate'}</strong> · up to {money(m.cap)} {m.every} to {short(m.to)}{m.paused ? ' · paused' : ''}{m.toAgent ? ' · pays the current agent' : ''}{m.continued ? ' · already continued in the new treasury' : !m.carryable ? ' · nothing left to pay' : ''}</span></label>)}</fieldset>}{!state.meta?.ledger?.rekey?.movedTo && <div className="desk-callout"><Icon name="lock" /><p>A treasury's keys are its identity, so new keys mean a new treasury: everything moves there with ordinary private transfers. Anyone who held the old keys keeps this treasury's history up to the move and cannot read the new treasury.</p></div>}</>}
        {action.type === 'agent' && <>{field('recipient', "Agent's ZKdesk address", <input type="text" maxLength={140} placeholder="zkd:…" autoComplete="off" spellCheck={false} />, 'From the agent: zkdesk_address in its MCP tools, or node agent/cli.mjs address.')}{field('threshold', 'Per payment without your approval · USDG', <input type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00" />, 'Any payment above this waits for your approval in Treasury. It applies to every member but you, the Treasurer too.')}<div className="desk-field-pair">{field('limit', 'Payments without approval', <input type="number" inputMode="numeric" min="0" max="1000" step="1" placeholder="No limit" />, '0 or blank: no count limit.')}{field('per', 'Per', <select><option value="day">Day</option><option value="week">Week</option></select>)}</div>{field('allowTo', 'Allowed recipients · optional', <textarea rows={3} maxLength={1200} placeholder={'zkd:… or 0x…, one per line'} autoComplete="off" spellCheck={false} />, 'Up to 8. Blank: the agent may pay anyone.')}<div className="desk-field-pair">{field('budget', 'Budget · USDG · optional', <input type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="No budget" />, 'The most the agent pays per period without your approval.')}{field('budgetPer', 'Per', <select><option value="day">Day</option><option value="week">Week</option><option value="month">30 days</option></select>)}</div><div className="desk-field-pair">{field('ends', 'Access ends', <select>{state.meta?.ledger?.scope?.ended && <option value="" disabled>Choose…</option>}{state.meta?.ledger?.scope?.ends && <option value="keep">{state.meta.ledger.scope.ended ? 'Keep the end that passed' : 'Unchanged'} ({when(state.meta.ledger.scope.ends)})</option>}<option value="none">No end</option><option value="1h">In 1 hour</option><option value="24h">In 24 hours</option><option value="7d">In 7 days</option><option value="30d">In 30 days</option><option value="date">On a date…</option></select>, 'After this the agent cannot pay or pull mandates, not even payments you approved (allow up to an hour, see below).')}{values.ends === 'date' && field('endsOn', 'Ends on', <input type="datetime-local" />)}</div><div className="desk-callout"><Icon name="lock" /><p>The recipient list, the budget and the access end are enforced by the proof, not by the agent: the chain rejects any payment outside them. A payment proof can be dated up to an hour back, so for up to an hour after the access end a payment dated before it can still go through; nothing after that. Payments you approve are outside the list and the budget, and so are mandates that are already active: they keep paying until you revoke them (after its access ends, the agent can no longer pay them, but it can still pause one until you remove it). With limits set, the agent can only pause mandates. Changing the agent, the threshold, the recipients, the budget or the access end starts the budget from zero.</p></div>{state.meta?.ledger?.payer !== 'owner' && <div className="desk-callout"><Icon name="lock" /><p>The agent replaces the current Payer{state.meta?.ledger?.payer === 'scheduler' ? ' (the ZKdesk scheduler, so mandates are no longer paid automatically)' : ''}. A treasury has one Payer.</p></div>}</>}
        {action.type === 'attest' && amountField('Declared liabilities · USDG', 'Only whether the treasury covers this amount is published. No balance is revealed.')}
        {action.type === 'mandate' && <>{field('kind', 'Mandate type', <select><option>Payroll</option><option>Invoice</option></select>)}{TESTNET ? <>{field('recipient', 'Recipient ZKdesk address', <input type="text" maxLength={140} placeholder="zkd:…" autoComplete="off" spellCheck={false} />, 'The recipient copies it from their Settings. Payments and receipts are private.')}{field('name', 'Recipient name · members only', <input type="text" maxLength={32} placeholder="Recipient or team name" autoComplete="off" />)}{field('asset', 'Pay in', <select><option value="USDG">{NET.usd}</option>{Object.keys(LTV).map((a) => <option key={a} value={a}>{NET.t}{a} · cap in USDG, paid at the pinned mark</option>)}</select>)}</> : field('recipient', 'Recipient', <input type="text" maxLength={80} placeholder="Recipient or team name" autoComplete="off" />)}{field('cap', 'Payment cap · USDG', <input type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00" />)}<div className="desk-field-pair">{field('period', 'Payment period', <select disabled={values.kind === 'Invoice'}><option>Monthly</option><option>Weekly</option><option>One-time</option></select>)}{field('expiry', 'Expiry date', <input type="date" min={today()} />)}</div>{values.kind === 'Invoice' && field('reference', 'Invoice reference', <input type="text" maxLength={100} placeholder="e.g. DEMO-002" />)}</>}
      </div>{errors.general && <p role="alert" className="desk-form-error">{errors.general}</p>}<p className="desk-form-note">{COPY.formNote}</p><div className="desk-dialog-actions"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary">Review details<Icon name="arrow" size={15} /></Button></div></form>}
  </Modal>;
}

const usd6 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const pub = { usd: (raw) => usd6.format(Number(raw) / 1e6), tokens: (raw, d = 18) => (Number(raw) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: 4 }), when: (t) => new Date(t).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) };
/** v3.18: what the treasury's agent (its Payer) paid, and every treasury payment, with a CSV export. */
function AgentSpending({ payments, money }) {
  const [all, setAll] = useState(false);
  if (!payments) return null;
  const rows = payments.rows.filter((r) => all || r.agent);
  const short = (x) => (!x ? '—' : x.length > 24 ? `${x.slice(0, 12)}…${x.slice(-6)}` : x);
  const amount = (r) => (r.symbol === 'USDG' ? money(r.amount) : `${r.amount.toLocaleString('en', { maximumFractionDigits: 6 })} ${r.symbol}`);
  const csv = () => {
    const lines = [['Date (UTC)', 'Amount', 'Asset', 'By', 'To', 'Recipient source', 'Mandate', 'Unreadable note', 'Transaction'],
      ...rows.map((r) => [r.at ?? '', r.amountText, r.symbol, r.by, r.to, r.toSource ?? 'unknown', r.mandate, r.mismatch ? 'yes' : '', r.link])];
    const url = URL.createObjectURL(new Blob([lines.map((l) => l.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `zkdesk-${all ? 'treasury' : 'agent'}-payments.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return <div className="desk-agent-spending">
    <div className="desk-panel-heading"><div><h3>{all ? 'Treasury payments' : 'Agent spending'}</h3><p>{payments.budget ? `${money(payments.spent)} of ${money(payments.budget)} spent by the agent this period.` : `${money(payments.spent)} spent by the agent this period.`} The agent's amounts and who paid come from the chain; so do recipients, except those marked *, which the paying app recorded or which are unknown. ! marks a payment whose notes the members cannot all read, so its amount or recipient may be incomplete.</p></div>
      <div className="desk-agent-actions"><Button variant="text" onClick={() => setAll(!all)}>{all ? 'Agent only' : 'All payments'}</Button><Button variant="text" disabled={!rows.length} onClick={csv}>Export CSV</Button></div></div>
    <PublicTable headers={['Date', 'Amount', 'To', 'By']} empty={all ? 'No payments from this treasury yet.' : 'The agent has not paid from this treasury yet.'}
      rows={rows.map((r) => [r.at ? <a href={r.link} target="_blank" rel="noreferrer">{date(r.at)}</a> : '—', amount(r), `${short(r.to)}${r.to && r.toSource !== 'chain' ? ' *' : ''}`, `${r.mandate ? `${r.by} · ${r.mandate}` : r.by}${r.mismatch ? ' !' : ''}`])} />
  </div>;
}
/** v3.19: the treasury's view key for alerts, shown only after the Owner reads what it can do. */
function ViewKeyRow({ onCopied }) {
  const [step, setStep] = useState('closed');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await adapter.viewKey());
      onCopied('Viewing key copied. Paste it only into your own alert watcher.');
      setStep('closed');
    } catch (error) {
      onCopied(error.message);
    }
  };
  return <div className="desk-setting-row"><div><h3>Viewing key for alerts</h3><p>{step === 'closed' ? 'Get Telegram or webhook alerts when your agent pays, nears its budget, or asks for approval, from a watcher you run (AI agents guide → Alerts).'
    : 'This key shows everything in this treasury: balances, payments and recipients. It cannot pay, approve or change roles, but whoever holds it can post approval requests (always check one in the dashboard before approving) and publish solvency statements. Keep it on a machine you control, and treat it like a password.'}</p></div>
    {step === 'closed' ? <Button onClick={() => setStep('warn')}>Copy viewing key</Button> : <div className="desk-agent-actions"><Button variant="text" onClick={() => setStep('closed')}>Cancel</Button><Button variant="primary" onClick={copy}>I understand, copy</Button></div>}</div>;
}
function PublicTable({ headers, rows, empty }) {
  return <div className="desk-table-scroll"><table className="desk-table"><thead><tr>{headers.map((h, i) => <th key={h} className={i ? 'align-right' : undefined}>{h}</th>)}</tr></thead><tbody>{rows.length ? rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'align-right desk-number' : undefined}>{c}</td>)}</tr>) : <tr><td className="desk-muted" colSpan={headers.length}>{empty}</td></tr>}</tbody></table></div>;
}
/** Public protocol aggregates. Nothing here belongs to one account. */
function TransparencyView({ data }) {
  if (!data) return <Empty title="Reading public proofs" detail={`Loading desk epochs, solvency and statements from ${NET.name}.`} />;
  if (data.error) return <Empty title="Public data is unavailable" detail={data.error} />;
  const { desk, lending, solvency, treasuries, payments, operations: ops } = data;
  const backed = solvency.filter((a) => a.ok).length;
  // The relayer floor stops user relays; the keeper floor stops desk epochs (the same key until a keeper is set).
  const gas = ops.keeperStatus === 'critical' ? ['', 'Gas critical: desk epochs paused'] : ops.relayerStatus === 'critical' ? ['', 'Gas critical: relays paused']
    : [ops.relayerStatus, ops.keeperStatus].includes('low') ? ['', 'Gas low: top up soon'] : ['blue', 'Gas healthy'];
  return <>
    <div className="desk-credit-summary"><div><span>Credit desk health</span><strong>#{desk.epoch}</strong></div><div><span>Lender pool</span><strong>{lending ? pub.usd(lending.totalAssets) : '—'}</strong></div><div><span>Pool solvency</span><strong>{backed}<small>/ {solvency.length} backed</small></strong></div></div>
    <section className="desk-panel"><div className="desk-panel-heading"><div><h2>Credit desk health</h2><p>Each epoch proves totals over every position at pinned marks. No position is revealed.</p></div><Badge tone={desk.healthy && !desk.paused ? 'blue' : ''}>{desk.paused ? 'New credit paused' : desk.healthy ? 'Epochs on time' : 'Epoch overdue'}</Badge></div>
      <PublicTable headers={['Epoch', 'Proven', 'Collateral value', 'Credit outstanding']} empty="No epoch yet." rows={desk.epochs.map((e) => [`#${e.epoch}`, pub.when(e.at), pub.usd(e.value), pub.usd(e.debt)])} /></section>
    <section className="desk-panel"><div className="desk-panel-heading"><div><h2>Sealed liquidation batches</h2><p>Breached positions sold at one uniform price. Only batch totals are public.</p></div></div>
      <PublicTable headers={['Batch', 'Asset', 'Positions', 'Collateral sold', 'Repaid to lenders', 'Uniform price']} empty="No liquidations yet." rows={desk.batches.map((b) => [pub.when(b.at), b.asset, b.positions, pub.tokens(b.sold), pub.usd(b.repaid), usd6.format(Number(b.price) / 1e8)])} /></section>
    <section className="desk-panel"><div className="desk-panel-heading"><div><h2>Pool solvency</h2><p>Tokens held by the shielded pool against every private note and pending deposit.</p></div></div>
      <PublicTable headers={['Asset', 'Held by the pool', 'Notes and pending deposits', 'Status']} empty="No snapshot yet." rows={solvency.map((a) => [a.asset, pub.tokens(a.balance, a.decimals), pub.tokens(a.backed, a.decimals), <Badge tone={a.ok ? 'blue' : ''}>{a.ok ? 'Backed' : 'Short'}</Badge>])} /></section>
    <section className="desk-panel"><div className="desk-panel-heading"><div><h2>Treasury statements</h2><p>{treasuries.count} treasuries · {payments.mandates.active ?? 0} active mandates · {payments.receipts} payment receipts. A statement proves assets cover the declared liabilities, never the balance.</p></div></div>
      <PublicTable headers={['Treasury', 'Statement', 'Liabilities covered', 'Proven']} empty="No statement yet." rows={treasuries.statements.map((t) => [t.treasury, `#${t.statement}`, pub.usd(t.liabilities), pub.when(t.at)])} /></section>
    <section className="desk-panel"><div className="desk-panel-heading"><div><h2>Operations and governance</h2><p>Who can change the protocol, and whether its services are running.</p></div><Badge tone={gas[0]}>{gas[1]}</Badge></div>
      <PublicTable headers={['Item', 'Current state']} empty="" rows={[
        ['Relayer gas', `${Number(ops.relayerEth).toFixed(5)} ETH`],
        ...(ops.separateKeeper ? [['Keeper gas (desk epochs, liquidations)', `${Number(ops.keeperEth).toFixed(5)} ETH`]] : []),
        ['Governance', ops.timelockDelay === null ? 'Deployer key' : `Safe ${ops.safeThreshold}-of-${ops.safeSigners} → ${ops.timelockDelay / 60}-minute timelock`],
        ['Emergency guardian', desk.paused ? 'New credit paused' : 'Can pause new credit at once; unpause via the timelock'],
        ['Underwriters', ops.staked === null ? '—' : `${pub.tokens(ops.staked)} tZKD staked · ${pub.usd(ops.insurance)} insurance`],
        ['Market hours', desk.marketOpen ? 'NYSE open' : 'NYSE closed: stricter liquidation floor'],
        ['Lender pool', lending ? `${(lending.utilizationBps / 100).toFixed(1)}% utilized · rate from the public curve ${(lending.aprBps / 100).toFixed(2)}%` : '—'],
      ]} /></section>
    <div className="desk-callout desk-wide-callout"><Icon name="shield" /><p>Everything on this page is built from data that is already public on {NET.name}.</p></div>
  </>;
}

function ReceiptDialog({ record, masked, money, onClose, onExport }) {
  const [includeAmount, setIncludeAmount] = useState(false);
  const [includeRecipient, setIncludeRecipient] = useState(false);
  const disclosed = receiptDisclosure(record, { includeAmount, includeRecipient, masked });
  const [verifier, setVerifier] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const proveAndExport = async () => {
    setError('');
    if (verifier.trim() && !/^0x[0-9a-fA-F]{1,40}$/.test(verifier.trim())) { setError('Enter the verifier as a 0x address, or leave it blank.'); return; }
    setBusy('Generating proof…');
    try {
      const proof = await adapter.proveReceipt(record.id, { verifier: verifier.trim() || '0', includeAmount: includeAmount && !masked, includeRecipient }, setBusy);
      const blob = new Blob([JSON.stringify(proof, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `zkdesk-receipt-${record.id.slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e.shortMessage || e.message); } finally { setBusy(''); }
  };
  if (TESTNET) return <Modal title="Your payment receipt." onClose={onClose}>
    <Badge tone="blue">Zero-knowledge receipt</Badge>
    <h3 className="desk-record-title">Choose what you share.</h3>
    <p className="desk-dialog-copy">Prove this payment to one verifier, such as a bank or landlord. Only what you select is disclosed.</p>
    <fieldset className="desk-disclosure-options"><legend>Optional receipt details</legend>
      <label><input type="checkbox" checked={includeAmount && !masked} disabled={masked} onChange={(event) => setIncludeAmount(event.target.checked)} /><span>Include amount</span></label>
      <label><input type="checkbox" checked={includeRecipient} onChange={(event) => setIncludeRecipient(event.target.checked)} /><span>Include my recipient key</span></label>
      {masked && <p>Balances are masked. Reveal them in the workspace to include the amount.</p>}
    </fieldset>
    <label className="desk-field"><span>Verifier address · optional</span><input type="text" value={verifier} onChange={(e) => setVerifier(e.target.value)} maxLength={42} placeholder="0x… · who this proof is for" autoComplete="off" spellCheck={false} /></label>
    <dl className="desk-review-list" aria-live="polite">
      <div><dt>Amount</dt><dd>{includeAmount && !masked ? money(record.amount) : 'Not included'}</dd></div>
      <div><dt>Recipient</dt><dd>{includeRecipient ? 'Your recipient key' : 'Not included'}</dd></div>
      <div><dt>Date</dt><dd>{date(record.at)}</dd></div>
      <div><dt>Paid by</dt><dd>{record.receipt.split('· ')[1]}</dd></div>
      <div><dt>Period</dt><dd>{record.period}</dd></div>
    </dl>
    <div className="desk-callout"><Icon name="lock" /><p>The proof is generated in your browser. Anyone can check it with scripts/verify-receipt.mjs or the MandateRegistry contract; it shows nothing you did not select.</p></div>
    {error && <p role="alert" className="desk-form-error">{error}</p>}
    <p className="desk-record-id">{record.receipt}</p>
    <div className="desk-dialog-actions"><Button onClick={onClose}>Done</Button><Button icon="export" onClick={proveAndExport} disabled={Boolean(busy)} aria-busy={Boolean(busy)}>{busy || 'Export receipt proof'}</Button></div>
  </Modal>;
  return <Modal title="Your demonstration receipt." onClose={onClose}>
    <Badge>Receipt preview</Badge>
    <h3 className="desk-record-title">Choose what you share.</h3>
    <p className="desk-dialog-copy">Select the details to include in this local receipt preview and exported record.</p>
    <fieldset className="desk-disclosure-options"><legend>Optional receipt details</legend>
      <label><input type="checkbox" checked={includeAmount && !masked} disabled={masked} onChange={(event) => setIncludeAmount(event.target.checked)} /><span>Include amount</span></label>
      <label><input type="checkbox" checked={includeRecipient} onChange={(event) => setIncludeRecipient(event.target.checked)} /><span>Include recipient</span></label>
      {masked && <p>Balances are masked. Reveal them in the workspace to include the amount.</p>}
    </fieldset>
    <dl className="desk-review-list" aria-live="polite">
      <div><dt>Amount</dt><dd>{disclosed.disclosure.amountIncluded ? money(record.amount) : 'Not included'}</dd></div>
      <div><dt>Recipient</dt><dd>{includeRecipient ? record.recipient : 'Not included'}</dd></div>
      <div><dt>Date</dt><dd>{date(record.at)}</dd></div>
      <div><dt>Category</dt><dd>Payments</dd></div>
      {record.period && <div><dt>Period</dt><dd>{record.period}</dd></div>}
    </dl>
    <div className="desk-callout"><Icon name="lock" /><p>Demonstration record only. No assets were transferred and no zero-knowledge receipt proof was generated.</p></div>
    <p className="desk-record-id">{record.receipt}</p>
    <div className="desk-dialog-actions"><Button onClick={onClose}>Done</Button><Button icon="export" onClick={() => onExport(disclosed)}>Export selected fields</Button></div>
  </Modal>;
}

export default function Dashboard() {
  const [state, setState] = useState(adapter.load);
  const [view, setView] = useState(getView);
  const [action, setAction] = useState(null);
  const [toast, setToast] = useState('');
  const [filter, setFilter] = useState('All');
  const [paymentFilter, setPaymentFilter] = useState('All');
  const total = totals(state);
  const allocationPercentages = distributionPercentages([state.cash, state.vault, total.collateral + state.freeStock]);
  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const money = (value) => state.masked ? '••••••' : currency.format(Number(value) || 0);
  const authorized = can(state.role, view === 'payments' ? 'payments' : 'treasury');
  useEffect(() => adapter.subscribe?.((next) => setState((prev) => ({ ...next, masked: prev.masked, role: !next.meta?.roles || next.meta.roles.includes(prev.role) ? prev.role : next.role }))), []);
  useEffect(() => { if (adapter.mode !== 'demo') return; try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { setToast('Local storage is unavailable. Changes will last for this session only.'); } }, [state]);
  useEffect(() => { const pop = () => setView(getView()); window.addEventListener('popstate', pop); document.title = COPY.title; return () => window.removeEventListener('popstate', pop); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4200); return () => clearTimeout(timer); }, [toast]);
  const navigate = (next) => { const url = new URL(window.location); url.searchParams.set('view', next); window.history.pushState({}, '', url); setView(next); setFilter('All'); window.scrollTo({ top: 0 }); };
  const simulate = async (type, values, onStatus) => { const next = await adapter.submit(state, type, values, onStatus); setState((prev) => ({ ...next, masked: prev.masked, role: next.meta?.roles?.includes(prev.role) ? prev.role : next.role })); setAction(null); setToast(next.meta?.notice || COPY.done); };
  const roleOptions = TESTNET && state.meta?.roles ? state.meta.roles : ROLES;
  const [publicData, setPublicData] = useState(null);
  useEffect(() => {
    if (view !== 'transparency' || !adapter.transparency) return;
    let live = true;
    const load = () => adapter.transparency().then((d) => live && setPublicData(d), (e) => live && setPublicData({ error: e.message }));
    load();
    const timer = setInterval(load, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [view]);
  const ledger = TESTNET ? state.meta?.ledger : null;
  const switchWorkspace = async (id) => { try { setToast('Switching workspace…'); await adapter.setWorkspace(id); setToast(''); } catch (error) { setToast(error.shortMessage || error.message); } };
  const connect = async () => { try { setToast('Check your wallet to connect and sign.'); await adapter.connect(); setToast('Wallet connected. Your private notes are unlocked.'); } catch (error) { setToast(error.shortMessage || error.message); } };
  const needsWallet = TESTNET && !state.meta?.connected;
  const [payRequest, setPayRequest] = useState(readRequest);
  useEffect(() => {
    if (!payRequest || needsWallet || !state.meta?.connected) return;
    setAction({ type: 'send', recipient: payRequest.to, amount: payRequest.amount, memo: payRequest.memo });
    setPayRequest(null);
    const url = new URL(window.location);
    for (const key of ['pay', 'amount', 'memo']) url.searchParams.delete(key);
    window.history.replaceState({}, '', url);
  }, [payRequest, needsWallet, state.meta?.connected]);
  const permission = (area) => !can(state.role, area) ? `${state.role} cannot perform this action. Change the demo role in Settings.` : undefined;
  const activeMandates = state.mandates.filter((item) => item.status === 'Active');
  const activity = filter === 'All' ? state.activity : state.activity.filter((item) => item.kind === filter);
  const mandates = paymentFilter === 'All' ? state.mandates : state.mandates.filter((item) => item.status === paymentFilter);
  const open = (type, extra = {}) => setAction({ type, ...extra });

  const activityTable = (rows, compact = false) => rows.length ? <div className="desk-table-scroll"><table className="desk-table"><thead><tr><th>Activity</th>{!compact && <th>Category</th>}<th>Date</th><th className="align-right">Amount</th><th><span className="desk-sr-only">Details</span></th></tr></thead><tbody>{rows.map((item) => <tr key={item.id}><td><div className="desk-table-identity"><span className="desk-table-icon"><Icon name={item.kind === 'Credit' ? 'credit' : item.kind === 'Payments' ? 'payments' : 'treasury'} /></span><div><strong>{item.title}</strong><span>{COPY.recordKind || (item.receipt ? 'Demonstration receipt' : 'Local simulation')}</span></div></div></td>{!compact && <td><Badge>{item.kind}</Badge></td>}<td className="desk-muted">{date(item.at)}</td><td className="align-right desk-number">{money(item.amount)}</td><td><button className="desk-icon-button" onClick={() => open('record', { id: item.id })} aria-label={`View ${item.title}`}><Icon name="arrow" size={16} /></button></td></tr>)}</tbody></table></div> : <Empty title="Nothing here yet" detail={TESTNET ? 'Your private notes and payments will appear here once you add funds.' : 'Your simulated activity will appear here as you use the workspace.'} />;

  return <div className="desk-app"><aside className="desk-sidebar"><a className="desk-brand" href="/" aria-label="ZKdesk home"><span className="desk-brand-icon"><ZMark width={21} height={22} /></span>ZKdesk</a><div className="desk-workspace"><span className="desk-workspace-avatar">D</span><div><strong>{state.meta?.workspaceName || COPY.workspace}</strong><span>{ledger ? `Treasury · ${NET.name}` : COPY.workspaceSub}</span></div><Icon name="lock" size={14} /></div><span className="desk-nav-label">WORKSPACE</span><nav aria-label="Dashboard navigation">{NAV.map((item) => <button className={`desk-nav-item ${view === item ? 'active' : ''}`} onClick={() => navigate(item)} key={item} aria-current={view === item ? 'page' : undefined}><Icon name={item} /><span>{LABELS[item]}</span>{view === item && <span className="desk-nav-dot" />}</button>)}</nav><div className="desk-sidebar-bottom"><div className="desk-sidebar-proof"><Icon name="shield" size={21} /><strong>Private by design.</strong><p>Explore the product.<br />Keep control of the details.</p><a href="/docs#privacy">Our privacy approach<Icon name="arrow" size={13} /></a></div><a className="desk-return" href="/"><Icon name="back" size={14} />Back to ZKdesk</a></div></aside>
    <div className="desk-main"><header className="desk-topbar"><div className="desk-breadcrumb">Workspace <span>/</span> <strong>{LABELS[view]}</strong></div><div className="desk-topbar-actions"><SoundToggle className="desk-sound-toggle" /><button className={`desk-icon-button ${state.masked ? 'is-active' : ''}`} onClick={() => setState({ ...state, masked: !state.masked })} aria-label={state.masked ? 'Reveal balances' : 'Mask balances'} title={state.masked ? 'Reveal balances' : 'Mask balances'} aria-pressed={state.masked}><Icon name="eye" /></button><span className="desk-topbar-divider" />{TESTNET && <div className="desk-net-switch" role="radiogroup" aria-label="Network">{['mainnet', 'testnet'].map((n) => <button key={n} type="button" role="radio" aria-checked={NET.network === n} className={NET.network === n ? 'on' : ''} disabled={n === 'mainnet' ? !NET.mainnetReady : !NET.testnetReady} title={n === 'mainnet' ? (NET.mainnetReady ? 'Robinhood Chain · real assets' : 'Mainnet (upgrading to v2)') : NET.testnetReady ? 'Robinhood Chain testnet · test assets' : 'Testnet (upgrading to v2)'} onClick={() => { if (NET.network === n) return; try { localStorage.setItem('zkdesk.network', n); } catch { /* storage unavailable: the URL still carries it */ } const u = new URL(window.location.href); u.searchParams.set('network', n); window.location.assign(u); }}><span className={`desk-net-dot ${n}`} aria-hidden="true" />{n === 'mainnet' ? 'Mainnet' : 'Testnet'}</button>)}</div>}{TESTNET ? <RoleMenu value={state.role} options={roleOptions} personal={!state.meta?.ledger} onChange={(role) => setState({ ...state, role })} /> : <label className="desk-role-select"><span className="desk-sr-only">Demo role</span><select value={state.role} onChange={(e) => setState({ ...state, role: e.target.value })}>{roleOptions.map((role) => <option key={role}>{role}</option>)}</select><Icon name="down" size={12} /></label>}{!TESTNET && <span className="desk-user-avatar">D</span>}</div></header>
    <main className="desk-content"><div className="desk-page-heading"><div><span className="desk-eyebrow">YOUR CONFIDENTIAL WORKSPACE</span><h1>{view === 'overview' ? 'A clear view. A private balance.' : LABELS[view]}</h1><p>{{ overview: 'Credit, treasury, and payments. All in one place.', credit: 'Access capital with private positions and precise controls.', treasury: 'A place for every asset. A permission for every role.', payments: 'Bounded permissions. Thoughtful payments.', activity: TESTNET ? 'Every private note and payment, with a clear record.' : 'Every local action, with a clear record.', settings: 'Your workspace, on your terms.', transparency: 'Public proofs and totals. Never a position, balance or name.' }[view]}</p></div><Badge tone="preview"><span />{COPY.badge}</Badge></div>
    {needsWallet && <div className="desk-callout desk-wide-callout desk-connect-callout"><Icon name="lock" /><p>{state.meta?.error ? `${state.meta.error} ` : ''}Unlock your private notes on {NET.name}: connect MetaMask and sign once (the signature never leaves this device and costs no gas), or use a passkey.</p><div className="desk-connect-actions"><Button onClick={() => open('passkey')}>Use a passkey</Button><Button variant="primary" onClick={connect}>Connect MetaMask</Button></div></div>}
    {!authorized && ['credit', 'treasury', 'payments'].includes(view) && <div className="desk-permission-note"><Icon name="lock" size={16} /><span>You are viewing as {state.role}. Some actions are unavailable for this role.</span><button onClick={() => navigate('settings')}>Manage role</button></div>}

    {payRequest && <div className="desk-callout desk-request-banner"><Icon name="lock" /><p><strong>Payment request{payRequest.amount ? `: ${payRequest.amount} ${NET.usd}` : ''}</strong> to {short(payRequest.to)}{payRequest.memo ? ` · “${payRequest.memo}”` : ''}. Unlock your account to review and pay it privately.</p></div>}
    {view === 'overview' && <><section className="desk-balance-panel"><div className="desk-balance-copy"><div className="desk-card-label">{COPY.total} <span className="desk-info-dot">i</span></div><div className="desk-total">{money(total.assets)}</div><p>Across liquid funds, allocations, and collateral.</p><div className="desk-balance-actions"><Button variant="primary" icon="plus" disabled={!can(state.role, 'treasury') || needsWallet} title={permission('treasury')} onClick={() => open('deposit')}>Add funds</Button><Button onClick={() => navigate('treasury')}>Manage treasury<Icon name="arrow" size={14} /></Button></div></div><div className="desk-allocation-graphic"><div className="desk-allocation-top"><span>Asset distribution</span><Badge>{TESTNET ? 'Private' : 'Sample'}</Badge></div><div className="desk-allocation-bars">{[state.cash, state.vault, total.collateral + state.freeStock].map((amount, index) => <span key={index} style={{ flex: Math.max(amount / (total.assets || 1), 0.025) }} />)}</div><div className="desk-allocation-legend"><span><i className="blue" />Liquid USDG<strong>{state.masked ? '••' : allocationPercentages[0]}%</strong></span><span><i className="pale" />Allocated<strong>{state.masked ? '••' : allocationPercentages[1]}%</strong></span><span><i className="silver" />Stock assets<strong>{state.masked ? '••' : allocationPercentages[2]}%</strong></span></div></div></section>
      <div className="desk-stat-grid"><button className="desk-stat-card" onClick={() => navigate('credit')}><span className="desk-card-label"><Icon name="credit" />Outstanding credit<Icon name="arrow" size={14} /></span><strong>{money(total.debt)}</strong><span>{state.positions.length} private {state.positions.length === 1 ? 'position' : 'positions'}</span></button><button className="desk-stat-card" onClick={() => navigate('treasury')}><span className="desk-card-label"><Icon name="treasury" />Allocated treasury<Icon name="arrow" size={14} /></span><strong>{money(state.vault)}</strong><span>{TESTNET ? (state.meta?.ledger ? 'Yield vault allocation' : 'Credit pool supply') : 'Sample vault allocation'}</span></button><button className="desk-stat-card" onClick={() => navigate('payments')}><span className="desk-card-label"><Icon name="payments" />Active mandates<Icon name="arrow" size={14} /></span><strong>{activeMandates.length.toString().padStart(2, '0')}</strong><span>{money(activeMandates.reduce((sum, item) => sum + item.cap, 0))} combined spending caps</span></button></div>
      <section className="desk-panel"><div className="desk-panel-heading"><div><h2>Recent activity</h2><p>{TESTNET ? 'Your latest private notes and payments.' : 'A record of your local workspace.'}</p></div><Button variant="text" onClick={() => navigate('activity')}>View all<Icon name="arrow" size={14} /></Button></div>{activityTable(state.activity.slice(0, 4), true)}</section><div className="desk-proof-strip"><span className="desk-proof-orb"><Icon name="shield" size={23} /></span><div><h3>Proof, without exposure.</h3><p>{TESTNET ? 'The desk proves its health every epoch and treasuries prove solvency, without exposing any balance.' : 'Explore how a solvency statement could be shared without exposing every balance.'}</p></div><Button onClick={() => (TESTNET ? navigate('transparency') : open('proof'))}>{TESTNET ? 'See public proofs' : 'Preview statement'}<Icon name="arrow" size={14} /></Button></div></>}

    {view === 'credit' && <><div className="desk-view-toolbar"><div><h2>Your positions <span>{state.positions.length}</span></h2><p>{TESTNET ? 'Private positions · pinned oracle marks · public rate curve' : 'Sample values. No live oracle or rate feed.'}</p></div><Button variant="primary" icon="plus" disabled={!authorized || needsWallet} title={permission('treasury')} onClick={() => open('open')}>Open credit</Button></div><div className="desk-credit-summary"><div><span>Collateral value</span><strong>{money(total.collateral)}</strong></div><div><span>Outstanding credit</span><strong>{money(total.debt)}</strong></div><div><span>Portfolio LTV</span><strong>{state.masked ? '••' : (total.collateral ? total.debt / total.collateral * 100 : 0).toFixed(1)}<small>%</small></strong></div></div>{TESTNET && (() => { const risky = state.positions.filter((x) => x.health !== null && x.health < 1.25); const below = risky.filter((x) => x.health < 1).length; return risky.length > 0 && <div className="desk-callout desk-health-alert" role="alert"><Icon name="shield" /><p><strong>{below ? (below === 1 && risky.length === 1 ? `Your ${risky[0].asset} position is below its liquidation threshold.` : `${below} of your positions are below their liquidation threshold.`) : risky.length === 1 ? `Your ${risky[0].asset} position is close to liquidation.` : `${risky.length} positions are close to liquidation.`}</strong> {below ? 'It is eligible for the next sealed batch; repay or add collateral now to bring health back above 1.' : 'Add collateral or repay to raise health above 1.25.'} Both are available at any time.</p></div>; })()}{state.positions.length ? <div className="desk-position-grid">{state.positions.map((position) => { const ratio = position.debt / position.collateral; return <section className="desk-position-card" key={position.id}><div className="desk-position-heading"><span className="desk-asset-mark">{position.asset.slice(0, 1)}</span><div><h3>{position.asset}</h3><p>{TESTNET ? (NET.mainnet ? 'Stock token · private' : 'Test stock token · private') : 'Tokenized stock · Sample'}</p></div><Badge tone={TESTNET && position.health !== null && position.health < 1 ? '' : 'blue'}>{TESTNET && position.health !== null && position.health < 1 ? 'Below threshold' : 'Private position'}</Badge></div><div className="desk-position-values"><div><span>Collateral value</span><strong>{money(position.collateral)}</strong></div><div><span>Outstanding credit</span><strong>{money(position.debt)}</strong></div></div><div className="desk-ltv-label"><span>{TESTNET ? 'Current LTV' : 'Opening LTV'}</span><strong>{state.masked ? '••' : (ratio * 100).toFixed(1)}% <i>/ {LTV[position.asset] * 100}% limit</i></strong></div><div className="desk-ltv-track"><span style={{ width: `${Math.min(ratio / LTV[position.asset] * 100, 100)}%` }} /></div>{TESTNET && position.health !== null && position.mark > 0 && <HealthGauge position={position} masked={state.masked} />}<p className="desk-position-note">{TESTNET ? healthNote(position, state.meta?.desk) : 'Specification limit · This is not a live health attestation.'}</p><div className="desk-position-actions"><Button disabled={!authorized || position.debt === 0} onClick={() => open('repay', { id: position.id })}>Repay</Button><Button disabled={!authorized} onClick={() => open('add', { id: position.id })}>Add collateral</Button><Button variant="text" disabled={!authorized} onClick={() => open('close', { id: position.id })}>Close<Icon name="arrow" size={13} /></Button></div></section>; })}</div> : <Empty title="Room for your next position" detail={TESTNET ? (NET.mainnet ? 'Borrow USDG against private stock tokens. Add funds in a stock token first.' : 'Borrow tUSDG against private test stock tokens. Add funds in a stock token first.') : 'Explore a collateralized USDG credit position using sample assets.'} action={authorized ? 'Open credit' : undefined} onAction={() => open('open')} />}<div className="desk-callout desk-wide-callout"><Icon name="shield" /><p>{TESTNET ? deskNote(state.meta?.desk) : 'Positions are designed to remain confidential. Production pricing would use a public rate curve; health and solvency would require real proof infrastructure.'}</p></div></>}

    {view === 'treasury' && <>{ledger?.rekey?.movedTo && <div className="desk-callout desk-moved"><Icon name="lock" /><p>This treasury moved to new keys. Its history stays here; new activity happens in the new treasury.{ledger.rekey.txs || ledger.rekey.mandates.length ? ' Some funds or mandates are still here.' : ''}{ledger.rekey.pending ? ' A deposit is still clearing; move it once it has cleared.' : ''}</p><Button onClick={() => switchWorkspace(ledger.rekey.movedTo)}>Open the new treasury</Button>{(ledger.rekey.txs > 0 || ledger.rekey.mandates.length > 0) && <Button onClick={() => open('rekey')}>Move remaining funds</Button>}</div>}<section className="desk-balance-panel desk-treasury-balance"><div className="desk-balance-copy"><div className="desk-card-label">Liquid treasury · USDG</div><div className="desk-total">{money(state.cash)}</div><p>{TESTNET && state.meta?.pending ? `${money(state.meta.pending)} is clearing the screening standby.` : ledger?.attested ? `Statement #${ledger.attested.epoch} proved these assets cover ${money(ledger.attested.liabilities)} in liabilities.` : 'Available for allocations, repayments, and payments.'}</p><div className="desk-balance-actions"><Button variant="primary" icon="plus" disabled={!authorized || needsWallet} onClick={() => open('deposit')}>Add funds</Button><Button disabled={!authorized || needsWallet || state.cash === 0} onClick={() => open('allocate')}>Allocate</Button><Button disabled={!authorized || needsWallet || state.vault === 0} onClick={() => open('deallocate')}>Move to liquid</Button>{TESTNET && <><Button disabled={needsWallet || state.cash === 0 || (ledger && !can(state.role, 'payments'))} title={ledger ? permission('payments') : undefined} onClick={() => open('send')}>Send privately</Button><Button disabled={needsWallet || !state.meta?.zkAddress} title="A link and QR code that opens a private send to this account" onClick={() => open('request')}>Request payment</Button><Button disabled={needsWallet || state.cash === 0 || (ledger && !can(state.role, 'payments'))} title={ledger ? permission('payments') : undefined} onClick={() => open('withdraw')}>Withdraw</Button>{!ledger && state.meta?.combinable > 1 && <Button disabled={needsWallet} title="Merge your private USDG notes so any amount can be sent in one step" onClick={() => open('combine')}>Combine notes ({state.meta.combinable})</Button>}</>}</div></div><div className="desk-treasury-seal"><Icon name="lock" size={38} /><span>Confidential ledger</span><small>{TESTNET ? NET.name : 'Demo preview'}</small></div></section><section className="desk-panel"><div className="desk-panel-heading"><div><h2>Asset allocation</h2><p>{ledger ? 'A precise view of this treasury. Only its members can see it.' : TESTNET ? 'A precise view of your private balance.' : 'A precise view of your sample balance.'}</p></div><Button variant="text" onClick={() => open(ledger ? 'attest' : 'proof')}>{ledger ? 'Prove solvency' : 'Preview solvency'}<Icon name="arrow" size={14} /></Button></div><div className="desk-table-scroll"><table className="desk-table"><thead><tr><th>Asset</th><th>Purpose</th><th>Status</th><th className="align-right">{TESTNET ? 'Value' : 'Sample value'}</th></tr></thead><tbody>{[['USDG', 'Liquid funds', 'Available', state.cash], [TESTNET && !ledger ? 'Credit pool shares' : 'Vault shares', ledger ? 'Yield vault' : TESTNET ? 'Private lending' : 'Treasury allocation', 'Allocated', state.vault], ['Stock collateral', 'Credit positions', 'Collateral', total.collateral], ['Stock assets', TESTNET ? 'Private stock tokens' : 'Returned collateral', 'Available', state.freeStock]].map(([asset, purpose, status, amount]) => <tr key={asset}><td><div className="desk-table-identity"><span className="desk-asset-dot">{asset === 'USDG' ? '$' : asset === 'Vault shares' ? 'V' : 'S'}</span><strong>{asset}</strong></div></td><td className="desk-muted">{purpose}</td><td><Badge>{status}</Badge></td><td className="align-right desk-number">{money(amount)}</td></tr>)}</tbody></table></div></section>{ledger && state.meta?.requests?.length > 0 && <section className="desk-panel"><div className="desk-panel-heading"><div><h2>Approval requests</h2><p>Transfers above the dual-control threshold wait here for the Owner. Only treasury members can read them.</p></div></div><PublicTable headers={['Requested', 'Amount', 'To', 'By', 'Status']} empty="" rows={state.meta.requests.map((r) => [date(r.at), r.symbol && r.symbol !== NET.usd ? `${r.amount} ${r.symbol}` : money(r.amount), r.to, `${r.mine ? `You (${r.role})` : r.role} (unverified)${r.role === 'Payer' && ledger.scope?.ended ? ' · agent access ended' : ''}`, ['Awaiting Owner', 'Declined'].includes(r.status) && state.role === 'Owner' ? <>{r.status === 'Declined' && <Badge>Declined (unverified)</Badge>}<Button onClick={() => open('approve', { id: r.id })}>{r.status === 'Declined' ? 'Approve anyway' : 'Approve'}</Button>{r.status === 'Awaiting Owner' && <Button variant="text" onClick={() => open('decline', { id: r.id })}>Decline</Button>}</> : r.status === 'Approved' && r.mine ? <Button onClick={() => open('complete', { id: r.id })}>Complete</Button> : <Badge tone={['Completed', 'Declined'].includes(r.status) ? '' : 'blue'}>{r.status === 'Declined' ? 'Declined (unverified)' : r.status}</Badge>])} /></section>}{TESTNET && ledger && <section className="desk-panel desk-agent-panel"><div className="desk-panel-heading"><div><h2>AI agent</h2><p>Let an AI agent pay from this treasury as its Payer. The proofs enforce your limits, and anything above its per-payment limit waits for your approval.</p></div>{state.role === 'Owner' && <div className="desk-agent-actions">{!['owner', 'scheduler'].includes(ledger.payer) && <Button variant="text" onClick={() => open('unagent')}>Remove agent</Button>}<Button onClick={() => open('agent')}>{['owner', 'scheduler'].includes(ledger.payer) ? 'Add an agent' : 'Change agent'}<Icon name="arrow" size={14} /></Button></div>}</div><dl className="desk-review-list desk-agent-list"><div><dt>Payer</dt><dd>{ledger.payer === 'owner' ? 'You · no agent' : ledger.payer === 'scheduler' ? 'ZKdesk scheduler' : `Agent or member · key ${ledger.payer}`}</dd></div><div><dt>Per payment</dt><dd>Up to {money(ledger.dualThreshold)} without your approval</dd></div><div><dt>Payments without approval</dt><dd>{ledger.limit ? `${ledger.limit.used} of ${ledger.limit.max} used this ${ledger.limit.days === 7 ? 'week' : ledger.limit.days === 1 ? 'day' : `${ledger.limit.days}-day window`}` : 'No count limit'}</dd></div><div><dt>Allowed recipients</dt><dd>{ledger.scope?.allowTo.length ? `${ledger.scope.allowTo.length} listed` : 'Anyone'}</dd></div><div><dt>Budget</dt><dd>{ledger.scope?.budget ? `${ledger.scope.spent === null ? '' : `${money(ledger.scope.spent)} of `}${money(ledger.scope.budget)} this ${ledger.scope.per === 'month' ? '30-day window' : ledger.scope.per ?? 'policy'}` : 'No budget'}</dd></div><div><dt>Access ends</dt><dd>{ledger.scope?.ends ? `${ledger.scope.ended ? 'Ended ' : ''}${when(ledger.scope.ends)}` : 'No end'}</dd></div></dl><p className="desk-agent-note">Set up the agent with the ZKdesk MCP server (<a href="/docs#agents">AI agents guide</a>). On-chain, nobody else can see which member paid; treasury members see below what the agent paid. Requests above the threshold appear under Approval requests.</p><AgentSpending payments={ledger.payments} money={money} /></section>}<section className="desk-role-card"><div><Icon name="settings" size={23} /><h3>Four roles. Clear boundaries.</h3><p>Owner manages access. Treasurer allocates. Payer executes bounded payments. Auditor has a view-only role.</p></div><div className="desk-role-chips">{ROLES.map((role) => <span key={role} className={state.role === role ? 'selected' : ''}>{role}</span>)}</div>{TESTNET && !needsWallet && !ledger ? <Button onClick={() => open('ledger')}>Set up a treasury<Icon name="arrow" size={14} /></Button> : ledger && state.role === 'Owner' ? <Button onClick={() => open('roles')}>Manage roles<Icon name="arrow" size={14} /></Button> : <Button onClick={() => navigate('settings')}>{ledger ? 'View your roles' : 'Manage demo role'}<Icon name="arrow" size={14} /></Button>}</section></>}

    {view === 'payments' && <><div className="desk-view-toolbar"><div><h2>Payment mandates</h2><p>Set the recipient, cap, period, and expiry.</p></div><Button variant="primary" icon="plus" disabled={!authorized} title={permission('payments')} onClick={() => open('mandate')}>Create mandate</Button></div><div className="desk-payment-summary"><div><span>Liquid USDG</span><strong>{money(state.cash)}</strong></div><div><span>Active mandates</span><strong>{activeMandates.length.toString().padStart(2, '0')}</strong></div><div><span>Combined caps</span><strong>{money(activeMandates.reduce((sum, item) => sum + item.cap, 0))}</strong></div></div><div className="desk-filter-tabs" aria-label="Mandate filter">{['All', 'Active', 'Paused', 'Complete', 'Revoked'].map((item) => <button className={paymentFilter === item ? 'selected' : ''} key={item} onClick={() => setPaymentFilter(item)} aria-pressed={paymentFilter === item}>{item}</button>)}</div>{mandates.length ? <div className="desk-mandate-list">{mandates.map((mandate) => <section className="desk-mandate-card" key={mandate.id}><div className="desk-mandate-main"><span className="desk-mandate-icon"><Icon name="payments" size={22} /></span><div><div className="desk-mandate-title"><h3>{mandate.recipient}</h3><Badge tone={mandate.status === 'Active' ? 'blue' : ''}>{mandate.expiry < today() && mandate.status === 'Active' ? 'Expired' : mandate.status}</Badge></div><p>{mandate.kind} · {mandate.period} · Expires {date(mandate.expiry)}</p></div><div className="desk-mandate-cap"><strong>{money(mandate.cap)}</strong><span>Spending cap</span></div></div><div className="desk-mandate-bottom"><span><Icon name="lock" size={13} />{mandate.paidLabel ? mandate.paidLabel : mandate.paidPeriod ? `Last simulated period: ${mandate.paidPeriod}` : 'No payments simulated yet'}</span><div><Button variant="text" disabled={!authorized || ['Complete', 'Revoked'].includes(mandate.status)} onClick={() => open(mandate.status === 'Paused' ? 'resume' : 'pause', { id: mandate.id })}>{mandate.status === 'Paused' ? 'Resume' : 'Pause'}</Button><Button variant="text" disabled={!authorized || ['Complete', 'Revoked'].includes(mandate.status)} onClick={() => open('revoke', { id: mandate.id })}>Revoke</Button><Button disabled={!authorized || !payable(mandate)} onClick={() => open('pay', { id: mandate.id })}>{TESTNET ? 'Pay now' : 'Simulate payment'}<Icon name="arrow" size={13} /></Button></div></div></section>)}</div> : <Empty title="No mandates in this view" detail="Create a payment permission, or choose another status to explore." action={authorized ? 'Create mandate' : undefined} onAction={() => open('mandate')} />}<p className="desk-page-note">{TESTNET ? (state.meta?.ledger ? <>Payments are private notes to each recipient. A mandate pays at most once per period, up to its cap; recipients can prove a payment with a zero-knowledge receipt. {state.meta.ledger.scheduled ? 'The ZKdesk scheduler is this treasury\'s Payer: due periods are paid automatically every hour, at the cap.' : <>For automatic payments, make the ZKdesk scheduler this treasury's Payer in Manage roles (it then sees the treasury as a Payer does). <Button variant="text" onClick={() => { navigator.clipboard?.writeText(state.meta.scheduler); setToast('Scheduler address copied.'); }}>Copy scheduler address</Button></>}</> : 'Mandates pay from a treasury. Switch to a treasury workspace in Settings, or set one up from Treasury.') : 'Payments use sample USDG. Each mandate can be simulated once per period; no tokens are transferred.'}</p></>}

    {view === 'activity' && <section className="desk-panel"><div className="desk-panel-heading"><div><h2>Workspace history</h2><p>{state.activity.length} {TESTNET ? 'private' : 'local'} {state.activity.length === 1 ? 'record' : 'records'}</p></div><Button icon="export" onClick={() => { exportRecord({ id: 'workspace-history', records: activity }); setToast(TESTNET ? 'Activity exported.' : 'Demo activity exported.'); }}>Export records</Button></div><div className="desk-filter-tabs inset">{['All', 'Credit', 'Treasury', 'Payments'].map((item) => <button className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)} key={item} aria-pressed={filter === item}>{item}</button>)}</div>{activityTable(activity)}</section>}

    {view === 'transparency' && <TransparencyView data={publicData} />}
    {view === 'settings' && <div className="desk-settings"><section className="desk-settings-group"><div className="desk-settings-heading"><h2>Workspace</h2><p>{TESTNET ? `Your workspace on ${NET.name}.` : 'Your local demonstration environment.'}</p></div>{TESTNET && state.meta?.connected ? <div className="desk-setting-row"><div><h3>Workspace</h3><p>Your personal account, or a treasury where you hold a role.</p></div><select aria-label="Workspace" value={state.meta.workspace} onChange={(e) => switchWorkspace(e.target.value)}><option value="personal">Personal account</option>{state.meta.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name} · {w.roles.join(', ')}</option>)}</select></div> : <div className="desk-setting-row"><div><h3>Workspace name</h3><p>A shared sample for exploring the product.</p></div><strong>Demo workspace</strong></div>}<div className="desk-setting-row"><div><h3>{ledger ? 'Acting role' : 'Preview role'}</h3><p>{ledger ? 'The roles you hold in this treasury. Each action is proven with your role key.' : TESTNET ? 'Your personal account: you own every note.' : 'Explore the permissions of each role. This selector is not authentication.'}</p></div><select aria-label="Preview role" value={state.role} onChange={(e) => setState({ ...state, role: e.target.value })}>{roleOptions.map((role) => <option key={role}>{role}</option>)}</select></div><div className="desk-setting-row"><div><h3>Mask balances</h3><p>Keep values discreet while navigating the workspace.</p></div><button className={`desk-switch ${state.masked ? 'on' : ''}`} role="switch" aria-checked={state.masked} aria-label="Mask balances" onClick={() => setState({ ...state, masked: !state.masked })}><span /></button></div></section><section className="desk-settings-group"><div className="desk-settings-heading"><h2>Integration status</h2><p>Clear boundaries for this preview.</p></div>{TESTNET && state.meta?.zkAddress && <div className="desk-setting-row"><div><h3>{ledger ? 'Treasury private address' : 'Your private address'}</h3><p>{ledger ? 'Anyone can pay into this treasury with it. It reveals no balance or member.' : 'Share it so others can send to you privately. It reveals no balance.'}</p></div><Button onClick={() => { navigator.clipboard?.writeText(state.meta.zkAddress); setToast('Private address copied.'); }}>Copy address</Button></div>}{TESTNET && ledger && state.meta?.roles?.includes('Owner') && adapter.viewKey && <ViewKeyRow onCopied={setToast} />}{TESTNET && ledger?.rekey && state.meta?.roles?.includes('Owner') && !(ledger.rekey.movedTo && !ledger.rekey.txs && !ledger.rekey.mandates.length && !ledger.rekey.governance) && <div className="desk-setting-row"><div><h3>Move to new keys</h3><p>{ledger.rekey.movedTo ? 'This treasury moved to new keys. Continue to move anything still here.' : 'Moves everything to a new treasury with new keys and the members you name. Use it when an agent or member is removed or the key of an agent or member may have leaked: the old keys cannot read the new treasury.'}</p></div><Button onClick={() => open('rekey')}>{ledger.rekey.movedTo ? 'Continue the move' : 'Move to new keys'}</Button></div>}{TESTNET && state.meta?.keySource === 'passkey' && <div className="desk-setting-row"><div><h3>Recovery key</h3><p>24 words that restore this account if your passkey is lost.</p></div><Button onClick={() => open('recovery')}>Show recovery key</Button></div>}{(TESTNET ? [['Transactions', NET.mainnet ? 'Robinhood Chain (4663) · real assets' : 'Robinhood Chain testnet (46630) · test assets'], ['Proofs', 'UltraHonk proofs generated in your browser'], ['Persistence', `On-chain notes; keys re-derived from your ${state.meta?.keySource === 'passkey' ? 'passkey' : 'wallet signature'}`], ['Wallet', state.meta?.address ? `${short(state.meta.address)}${state.meta.keySource === 'passkey' ? ' · funds deposits' : ''}` : state.meta?.keySource === 'passkey' ? 'Asked for when you add funds' : 'Not connected']] : [['Transactions', 'Local simulations only'], ['Proofs and receipts', 'Preview records; no ZK proofs generated'], ['Persistence', 'This browser’s local storage'], ['Network', 'Designed for Robinhood Chain; not connected']]).map(([name, status]) => <div className="desk-setting-row" key={name}><h3>{name}</h3><span className="desk-muted">{status}</span></div>)}</section>{!TESTNET && <section className="desk-settings-group"><div className="desk-setting-row"><div><h3>Start fresh</h3><p>Reset balances, positions, mandates, and activity to the original sample.</p></div><Button variant="danger-soft" disabled={state.role !== 'Owner'} title={state.role !== 'Owner' ? 'Switch to Owner to reset this workspace.' : undefined} onClick={() => open('reset')}>Reset demo</Button></div></section>}</div>}
    <footer className="desk-page-footer"><span><Icon name="lock" size={12} />{COPY.footer}</span><span>ZKdesk product preview</span></footer></main></div>
    {toast && <div className="desk-toast" role="status"><Icon name="check" size={16} />{toast}<button onClick={() => setToast('')} aria-label="Dismiss notification"><Icon name="close" size={14} /></button></div>}
    {action && TITLES[action.type] && <ActionDialog key={`${action.type}-${action.id || ''}`} action={action} state={state} money={money} onClose={() => setAction(null)} onConfirm={simulate} />}
    {action?.type === 'passkey' && <PasskeyDialog onClose={() => setAction(null)} onDone={(message) => { setAction(null); setToast(message); }} />}
    {action?.type === 'recovery' && <RecoveryDialog onClose={() => setAction(null)} />}
    {action?.type === 'request' && <RequestDialog state={state} onClose={() => setAction(null)} onCopied={setToast} />}
    {action?.type === 'reset' && <Modal title="Start with a fresh balance." onClose={() => setAction(null)}><p className="desk-dialog-copy">This clears your local demo activity and restores the original sample balances and mandates. It does not affect any real assets.</p><div className="desk-dialog-actions"><Button onClick={() => setAction(null)}>Keep workspace</Button><Button variant="danger" onClick={() => { setState(initialState()); setAction(null); setToast('Demo workspace reset to its original sample.'); }}>Reset demo</Button></div></Modal>}
    {action?.type === 'proof' && <Modal title="A statement. Not your balance." onClose={() => setAction(null)}><p className="desk-dialog-copy">This preview illustrates a treasury solvency statement. It has no cryptographic verification.</p><div className="desk-proof-preview"><Icon name="shield" size={38} /><h3>Solvency statement preview</h3><p>Sample assets {total.assets >= total.debt ? 'meet' : 'do not meet'} the sample credit liabilities.</p><Badge>Proof not generated</Badge></div><dl className="desk-review-list"><div><dt>Statement scope</dt><dd>Demo treasury</dd></div><div><dt>Verification</dt><dd>Unavailable in this preview</dd></div><div><dt>Production requirement</dt><dd>Prover + contract integration</dd></div></dl><div className="desk-dialog-actions"><Button onClick={() => setAction(null)}>Close preview</Button><Button icon="export" onClick={() => exportRecord({ id: 'solvency-preview', statement: 'Illustrative solvency statement', condition: total.assets >= total.debt, verified: false })}>Export demo record</Button></div></Modal>}
    {action?.type === 'record' && (() => { const record = state.activity.find((item) => item.id === action.id); if (record?.receipt) return <ReceiptDialog key={record.id} record={record} masked={state.masked} money={money} onClose={() => setAction(null)} onExport={(disclosed) => { exportRecord(disclosed); setToast('Selected demo receipt fields exported.'); }} />; return <Modal title={record?.receipt ? 'Your demonstration receipt.' : 'Activity details'} onClose={() => setAction(null)}><Badge>{record?.receipt ? 'Receipt preview' : 'Local simulation'}</Badge><h3 className="desk-record-title">{record?.title}</h3><dl className="desk-review-list"><div><dt>Amount</dt><dd>{money(record?.amount)}</dd></div><div><dt>Date</dt><dd>{date(record?.at)}</dd></div><div><dt>Category</dt><dd>{record?.kind}</dd></div>{record?.recipient && <div><dt>Recipient</dt><dd>{record.recipient}</dd></div>}{record?.period && <div><dt>Period</dt><dd>{record.period}</dd></div>}</dl><p className="desk-dialog-copy">{state.masked ? 'Record details are hidden while balances are masked.' : record?.detail}</p>{record?.receipt && <p className="desk-record-id">{record.receipt}</p>}<div className="desk-dialog-actions"><Button onClick={() => setAction(null)}>Done</Button><Button icon="export" onClick={() => { exportRecord(record); setToast('Demo record exported.'); }}>Export demo record</Button></div></Modal>; })()}
  </div>;
}
