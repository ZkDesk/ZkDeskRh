import React, { useId } from 'react';

export function ZMark(props) {
  const maskId = `zkdesk-final-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return <svg viewBox="0 0 19 20" fill="none" aria-hidden="true" {...props}>
    <defs>
      <mask id={maskId} x="0" y="0" width="19" height="20" maskUnits="userSpaceOnUse" style={{ maskType: 'alpha' }}>
        <image href="/brand/zkdesk-logo-final.png" x="0" y="0" width="19" height="20" preserveAspectRatio="xMidYMid meet" />
      </mask>
    </defs>
    <rect width="19" height="20" fill="currentColor" mask={`url(#${maskId})`} />
  </svg>;
}

export function finalMarkup(markup) {
  let result = markup
    .replaceAll('type="image/webp"', 'type="image/png"')
    .replaceAll('href="#how-it-works"', 'href="#workflow"')
    .replaceAll('Explore the ZKdesk product preview', 'Open your confidential workspace')
    .replaceAll('href="#privacy"', 'href="/docs#privacy"');
  result = result.replace(/<source\b[^>]*>/g, source => source.includes('/brand/invisible-finance-eye.svg')
    ? source.replace('type="image/png"', 'type="image/svg+xml"')
    : source);
  if(markup.includes('class="home-hero"')) result=result.replace('href="#product-preview"','href="/dashboard"');
  if(markup.includes('text-block blue')) result=result.replace('href="#about"','href="/docs#privacy"');
  if(markup.includes('class="nav-list"')) {
    result=result.replace('<span class="nav-list-item-index" data-v-4b5b0323="">05</span><button class="nav-list-item-link" data-v-4b5b0323="" type="button">Search</button>',
      '<span class="nav-list-item-index" data-v-4b5b0323="">05</span><a class="nav-list-item-link" data-v-4b5b0323="" href="/docs">Docs</a></li><li class="nav-list-item" data-v-4b5b0323=""><span class="nav-list-item-index" data-v-4b5b0323="">06</span><button class="nav-list-item-link" data-v-4b5b0323="" type="button">Search</button>');
  }
  if(markup.includes('class="footer"')) {
    result=result.replace('</ul>','<li class="links-list-item" data-v-47bb011d=""><a href="#roadmap" data-v-47bb011d="">Roadmap</a></li></ul>')
      .replaceAll('href="#product-preview"','href="/docs#status"')
      .replaceAll('href="#eligibility"','href="/docs#eligibility"')
      .replaceAll(' target="_blank"','');
    // Documentation, right after Workspace, reusing its markup (arrow icon included).
    const at=result.indexOf('href="/dashboard"');
    if(at>-1) {
      const end=result.indexOf('</li>',at)+5;
      const item=result.slice(result.lastIndexOf('<li',at),end);
      result=result.slice(0,end)+item.replace('href="/dashboard"','href="/docs"').replace('Workspace</a>','Documentation</a>')+result.slice(end);
      // Socials at the end of the Explore list.
      const social=(href,label)=>item.replace('href="/dashboard"',`href="${href}" target="_blank" rel="noopener noreferrer"`).replace('Workspace</a>',`${label}</a>`);
      const listEnd=result.indexOf('</ul>',at);
      result=result.slice(0,listEnd)+social('https://x.com/ZkDesk','X')+social('https://t.me/zkdeskrh','Telegram')+social('https://github.com/ZkDesk/ZkDeskRh','GitHub')+result.slice(listEnd);
    }
  }
  return result;
}
