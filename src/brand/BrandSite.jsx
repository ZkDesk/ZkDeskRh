import React, { useEffect, useRef, useState } from 'react';
import parse, { attributesToProps, domToReact } from 'html-react-parser';
import { useSourceInteractions } from '../baseline/useSourceInteractions.js';
import navigation from './fragments/Navigation.html?raw';
import pageBackground from './fragments/PageBackground.html?raw';
import hero from './fragments/Hero.html?raw';
import overview from './fragments/Overview.html?raw';
import company from './fragments/CompanyDetails.html?raw';
import products from './fragments/Products.html?raw';
import about from './fragments/About.html?raw';
import masterPlan from './fragments/MasterPlan.html?raw';
import contact from './fragments/Contact.html?raw';
import stickyLogo from './fragments/StickyLogo.html?raw';
import footer from './fragments/Footer.html?raw';
import { finalMarkup, ZMark } from './identity.jsx';

const MENU_SCOPE = { 'data-v-4b5b0323': '' };
const PAGES = [
  ['Private credit', '#credit'],
  ['Treasury', '#treasury'],
  ['Payroll and invoices', '#payments'],
  ['About ZKdesk', '#about'],
  ['How it works', '#how-it-works'],
  ['Roadmap', '#roadmap'],
  ['Questions', '#questions'],
  ['Privacy and disclosure', '#privacy'],
  ['Open dashboard', '/dashboard'],
];

// Set VITE_ZKDESK_CA in Vercel (non-sensitive) and redeploy; Vite inlines it at build time.
const CONTRACT_ADDRESS = import.meta.env.VITE_ZKDESK_CA || 'TBA';

function ContractAddress() {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(CONTRACT_ADDRESS).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, () => {});
  return <button type="button" className="zk-ca" onClick={copy} aria-label={`Copy contract address ${CONTRACT_ADDRESS}`}>
    CA : <span className="zk-ca-value">{CONTRACT_ADDRESS}</span>
    <span className="zk-ca-status" aria-live="polite">{copied ? 'Copied' : ''}</span>
  </button>;
}

/** Same semantic DOM as the verified source. Copy lives in editable fragments. */
export const BrandFragment = React.memo(function BrandFragment({ markup, enhanced = false }) {
  const options = { replace(node) {
    if(enhanced && node.name === 'svg' && (node.attribs?.viewbox || node.attribs?.viewBox) === '0 0 19 20') return <ZMark {...attributesToProps(node.attribs)} />;
    if(enhanced && node.attribs?.class === 'category-wrapper') return <>
      <div {...attributesToProps(node.attribs)}>{domToReact(node.children, options)}</div>
      <ContractAddress />
    </>;
  }};
  return parse(enhanced ? finalMarkup(markup) : markup, options);
});

export function BrandNavigation({ enhanced = false }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [subMenu, setSubMenu] = useState('');
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState('white');
  const menuRef = useRef(null);
  const openerRef = useRef(null);
  const subMenuTriggerRef = useRef(null);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 833px)').matches);
  const overlayOpen = mobileOpen || Boolean(subMenu);
  const focusLater = (target) => requestAnimationFrame(() => {
    if (target?.isConnected) target.focus({ preventScroll: true });
  });
  const close = (restoreFocus = true) => {
    setMobileOpen(false); setSubMenu(''); setQuery('');
    if (restoreFocus) focusLater(openerRef.current);
  };
  const closeSubMenu = () => {
    setSubMenu(''); setQuery('');
    focusLater(subMenuTriggerRef.current);
  };
  const onNavigate = (event) => {
    close(false);
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const destination = new URL(event.currentTarget.href, window.location.href);
    if (destination.pathname !== window.location.pathname || !destination.hash) return;
    const target = document.getElementById(decodeURIComponent(destination.hash.slice(1)));
    if (!target) return;
    // Preserve the native anchor scroll, then move keyboard reading order with it.
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }
    focusLater(target);
  };
  useEffect(() => {
    const media = window.matchMedia('(max-width: 833px)');
    const update = () => { setIsMobile(media.matches); if (!media.matches) setMobileOpen(false); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const update = () => {
      const sections = [...document.querySelectorAll('.home-hero, main > .section, .footer')];
      const active = [...sections].reverse().find((el) => el.getBoundingClientRect().top <= 50);
      const next = active?.classList.contains('home-hero') ? 'white'
        : active?.classList.contains('footer') ? 'off-black'
        : [...(active?.classList || [])].find((name) => name.startsWith('bg-'))?.slice(3) || 'white';
      setTheme(next);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  useEffect(() => {
    const menu = menuRef.current;
    if (!overlayOpen || !menu) return;
    const inertSiblings = [];
    // Inert siblings at each level, never the ancestor containing the menu.
    let branch = menu;
    while (branch.parentElement && branch !== document.body) {
      [...branch.parentElement.children].forEach((sibling) => {
        if (sibling === branch || ['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) return;
        inertSiblings.push([sibling, sibling.inert]);
        sibling.inert = true;
      });
      branch = branch.parentElement;
    }
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...menu.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]')]
      .filter((el) => el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    const entry = requestAnimationFrame(() => {
      const target = subMenu === 'Search' ? menu.querySelector('.nav-sub-items.search input')
        : subMenu ? menu.querySelector('.nav-sub-items[aria-hidden="false"] button')
        : subMenuTriggerRef.current || menu.querySelector('.nav-list button, .nav-list a');
      target?.focus({ preventScroll: true });
    });
    const trap = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      const index = controls.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (index === -1 || document.activeElement === last)) { event.preventDefault(); first.focus(); }
    };
    menu.addEventListener('keydown', trap);
    return () => {
      cancelAnimationFrame(entry);
      menu.removeEventListener('keydown', trap);
      document.body.style.overflow = priorOverflow;
      inertSiblings.forEach(([el, wasInert]) => { el.inert = wasInert; });
    };
  }, [overlayOpen, mobileOpen, subMenu, isMobile]);

  const options = {
    replace(node) {
      if (node.type !== 'tag') return;
      const classes = (node.attribs.class || '').split(' ');
      const props = attributesToProps(node.attribs);
      if(enhanced && node.name === 'svg' && (node.attribs?.viewbox || node.attribs?.viewBox) === '0 0 19 20') return <ZMark {...props} />;
      if (classes.includes('menu')) {
        return <div {...props} ref={menuRef} role={overlayOpen ? 'dialog' : undefined} aria-modal={overlayOpen ? true : undefined} aria-label={overlayOpen ? 'Navigation' : undefined} className={`menu ${theme} baseline-visible${mobileOpen ? ' open' : ''}${subMenu ? ' sub-menu-open' : ''}${subMenu === 'Search' ? ' search-open' : ''}`}>
          {domToReact(node.children, options)}
        </div>;
      }
      if (classes.includes('burger')) return <button {...props} aria-expanded={mobileOpen} aria-controls="zk-primary-navigation" onClick={(event) => { if (mobileOpen) close(); else { openerRef.current = event.currentTarget; subMenuTriggerRef.current = null; setMobileOpen(true); setSubMenu(''); setQuery(''); } }}>{domToReact(node.children, options)}</button>;
      if (classes.includes('background')) return <button {...props} onClick={() => close()} tabIndex={-1} aria-hidden="true" />;
      if (classes.includes('nav') && node.name === 'nav') return <nav {...props} id="zk-primary-navigation" aria-label="Main navigation">{domToReact(node.children, options)}</nav>;
      if (classes.includes('nav-list')) return <ul {...props} style={subMenu ? { opacity: 0, pointerEvents: 'none' } : {}} aria-hidden={Boolean(subMenu) || (isMobile && !mobileOpen)} inert={Boolean(subMenu) || (isMobile && !mobileOpen)}>{domToReact(node.children, options)}</ul>;
      if (classes.includes('nav-list-item-link') && node.name === 'button') {
        const label = node.children.map((child) => child.data || '').join('').trim();
        return <button {...props} aria-expanded={subMenu === label} onClick={(event) => { if (!overlayOpen) openerRef.current = event.currentTarget; subMenuTriggerRef.current = event.currentTarget; setSubMenu(subMenu === label ? '' : label); }}>{domToReact(node.children, options)}</button>;
      }
      if (classes.includes('nav-sub-items-back')) return <button {...props} aria-label="Back to navigation" onClick={closeSubMenu}>{domToReact(node.children, options)}</button>;
      if (classes.includes('nav-sub-items')) {
        const isSearch = classes.includes('search');
        const titleNode = node.children[0]?.children?.[0]?.children?.find((child) => child.attribs?.class === 'nav-sub-items-title');
        const title = titleNode?.children?.find((child) => child.type === 'text')?.data?.trim() || '';
        const shown = subMenu === (isSearch ? 'Search' : title);
        const results = query.trim() ? PAGES.filter(([label]) => label.toLowerCase().includes(query.toLowerCase().trim())) : [];
        return <div {...props} style={{ display: shown ? 'block' : 'none' }} aria-hidden={!shown}>
          {domToReact(node.children, options)}
          {isSearch && query.trim() && <div className="baseline-search-results" {...MENU_SCOPE}>
            {results.length ? <ul className="nav-sub-items-list" {...MENU_SCOPE}>{results.map(([label, path]) => <li className="nav-sub-items-list-item" key={path} {...MENU_SCOPE}>
              <a className="nav-sub-items-list-link" href={enhanced && path === '#how-it-works' ? '#workflow' : enhanced && path === '#privacy' ? '/docs#privacy' : path} onClick={onNavigate} {...MENU_SCOPE}>{label}</a>
            </li>)}</ul> : <p role="status" className="baseline-no-results">No results found</p>}
          </div>}
        </div>;
      }
      if (node.name === 'input') return <input {...props} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search ZKdesk products and pages" />;
      if (node.name === 'a') return <a {...props} onClick={onNavigate}>{domToReact(node.children, options)}</a>;
    },
  };
  return parse(enhanced ? finalMarkup(navigation) : navigation, options);
}

export default function BrandSite({ afterProducts = null, afterAbout = null, enhanced = false }) {
  useSourceInteractions();
  const fragment = markup => <BrandFragment markup={markup} enhanced={enhanced} />;
  return <div className={enhanced ? 'zk-site' : undefined}>
    {enhanced && <a className="zk-skip" href="#main">Skip to content</a>}
    <BrandNavigation enhanced={enhanced} />
    {fragment(pageBackground)}
    <div>
      {fragment(hero)}
      <main className="main" id="main" data-v-e16278ef="">
        {fragment(overview)}
        {fragment(company)}
        {fragment(products)}
        {afterProducts}
        {fragment(about)}
        {afterAbout}
        {fragment(masterPlan)}
        {fragment(contact)}
        {fragment(stickyLogo)}
      </main>
      {fragment(footer)}
    </div>
  </div>;
}
