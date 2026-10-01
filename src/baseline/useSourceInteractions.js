import { useLayoutEffect } from 'react';

// Reveal and scroll timings for the landing page's hero, intro and product sections.
const OUT = 'cubic-bezier(0.165, 0.84, 0.44, 1)';
const IN = 'cubic-bezier(0.895, 0.03, 0.685, 0.22)';

export function useSourceInteractions() {
  useLayoutEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animations = new Set();
    const cleanups = [];
    const observers = [];
    const splitRoots = new Set();
    const splitTextRecords = [];
    const revealNames = new Map();
    const shownElements = new Set();
    const behavior = reduced ? 'instant' : 'smooth';
    const select = (selector, root = document) => [...root.querySelectorAll(selector)];
    const show = (el) => { if (el) { shownElements.add(el); el.classList.add('baseline-visible'); } };
    const animate = (el, frames, duration, delay = 0, easing = 'linear') => {
      if (!el) return;
      if (reduced) {
        Object.assign(el.style, frames[frames.length - 1]);
        return;
      }
      const animation = el.animate(frames, { duration, delay, easing, fill: 'both' });
      animations.add(animation);
      animation.addEventListener('finish', () => queueMicrotask(() => {
        // Keep settled styles without accumulating fill-forwards effects forever
        // as the overview phrase rotates. Caller onfinish handlers run first.
        if (animation.playState === 'finished') {
          try { animation.commitStyles(); } catch { Object.assign(el.style, frames[frames.length - 1]); }
          animation.cancel();
        }
        animations.delete(animation);
      }), { once: true });
      return animation;
    };
    const observe = (el, callback, threshold = .3) => {
      if (!el) return;
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          callback();
          observer.disconnect();
        }
      }, { threshold });
      observers.push(observer);
      observer.observe(el);
    };
    // Custom inline tags avoid source rules such as `.title span {display:block}`.
    // Spaces and original inline markup are preserved, so wrapping stays native.
    const words = (root) => {
      if (!root) return [];
      if (splitRoots.has(root) || root.querySelector('source-motion-word')) return select('source-motion-word', root);
      splitRoots.add(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.trim()) textNodes.push(walker.currentNode);
      }
      textNodes.forEach((text) => {
        const fragment = document.createDocumentFragment();
        const start = document.createComment('source-motion-start');
        const end = document.createComment('source-motion-end');
        fragment.append(start);
        text.textContent.split(/(\s+)/).forEach((part) => {
          if (!part.trim()) fragment.append(document.createTextNode(part));
          else {
            const word = document.createElement('source-motion-word');
            word.textContent = part;
            fragment.append(word);
          }
        });
        fragment.append(end);
        splitTextRecords.push({ original: text, start, end });
        text.replaceWith(fragment);
      });
      return select('source-motion-word', root);
    };
    const title = (el, delay = 0) => {
      if (el && !revealNames.has(el)) {
        revealNames.set(el, el.getAttribute('aria-label'));
        const content = el.querySelector(':scope > div') || el;
        // Source titles may use two block spans without a literal separator.
        const label = [...content.childNodes].map((node) => node.textContent).join(' ').replace(/\s+/g, ' ').trim();
        if (label) el.setAttribute('aria-label', label);
      }
      show(el);
      words(el).forEach((word, index) => animate(word,
        [{ opacity: 0, filter: 'blur(10px)' }, { opacity: 1, filter: 'blur(0px)' }],
        1300, delay + index * 100));
    };
    const copy = (el, delay = 0, duration = 1000, stagger = 80, y = 40) => {
      show(el);
      const list = words(el);
      const tops = [];
      list.forEach((word) => {
        const top = Math.round(word.getBoundingClientRect().top);
        if (!tops.includes(top)) tops.push(top);
      });
      list.forEach((word) => {
        const line = tops.indexOf(Math.round(word.getBoundingClientRect().top));
        animate(word, [{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: 'translateY(0)' }], duration, delay + line * stagger, OUT);
      });
    };
    const link = (el, delay = 0) => {
      show(el);
      // Animate the children because baseline-visible controls parent visibility.
      select(':scope > *', el).forEach((child) => animate(child,
        [{ opacity: 0, transform: 'translateY(40px)' }, { opacity: 1, transform: 'translateY(0)' }], 1000, delay, OUT));
    };

    // Source container visibility is instantaneous; its children carry the motion.
    select('.home-hero-container').forEach(show);
    select('.home-intro-container, .home-company-details-container, .home-about-item, .home-master-plan-container, .text-block-container').forEach((el) => observe(el, () => show(el), 0));
    const heroImage = document.querySelector('.home-hero > .image-wrapper');
    show(heroImage);
    animate(heroImage, [{ filter: 'blur(10px)', transform: 'scale(1.1)' }, { filter: 'blur(0px)', transform: 'scale(1)' }], 2000, 0, OUT);
    animate(heroImage?.querySelector('img'), [{ opacity: 0 }, { opacity: 1 }], 2000, 0, OUT);
    const hero = document.querySelector('.home-hero');
    if (hero) {
      animate(hero.querySelector('.head'), [{ opacity: 0, transform: 'translateY(-50px)' }, { opacity: 1, transform: 'translateY(0)' }], 1200, 1300, OUT);
      animate(hero.querySelector('.logo'), [{ opacity: 0, filter: 'blur(10px)' }, { opacity: 1, filter: 'blur(0px)' }], 1500, 100);
      title(hero.querySelector('.title-reveal'), 400);
      animate(hero.querySelector('.category-wrapper'), [{ opacity: 0 }, { opacity: 1 }], 1100, 1200);
      const indicator = hero.querySelector('.home-hero-scroll-indicator');
      show(indicator);
      animate(indicator, [{ transform: 'translateY(30px)' }, { transform: 'translateY(0)' }], 1000, 1300, OUT);
    }
    const handled = new Set(select('.home-hero .title-reveal'));
    const intro = document.querySelector('.home-intro');
    const introTitle = intro?.querySelector('.title-reveal');
    if (introTitle) handled.add(introTitle);
    observe(intro, () => {
      title(introTitle);
      // The rotating last line has its own word blur transition.
      copy(intro?.querySelector('.copy'), 200, 800, 50, 50);
      link(intro?.querySelector('.link'), 450);
    }, 0);

    select('.title-reveal, .copy-reveal').forEach((el) => {
      if (handled.has(el)) return;
      let delay = 0;
      if (el.closest('.home-master-plan') && el.matches('.copy-reveal')) delay = 200;
      if (el.closest('.text-block')) {
        const item = el.closest('.item');
        delay = item && item.previousElementSibling ? 300 : 0;
        if (el.matches('.copy-reveal')) delay += 100;
      }
      if (el.matches('.copy-reveal')) {
        if (el.closest('.text-block') || (el.closest('.home-products') && !el.classList.contains('sub-copy'))) el.style.setProperty('--baseline-opacity', '.5');
        if (el.closest('.home-master-plan')) el.style.setProperty('--baseline-opacity', '.7');
      }
      observe(el, () => el.matches('.title-reveal') ? title(el, delay) : copy(el, delay));
    });
    select('.home-about-item').forEach((item) => observe(item, () => {
      animate(item.querySelector(':scope > .title'), [{ opacity: 0 }, { opacity: 1 }], 1200, 0, OUT);
      select('.copy > *', item).forEach((el) => copy(el, 100, 600, 50, 50));
      link(item.querySelector('.link'), 150);
      animate(item.querySelector('.sub-copy'), [{ opacity: 0 }, { opacity: .4 }], 1200, 300);
      animate(item.querySelector(':scope > .line'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], 2000, 700, OUT);
    }));
    select('.home-master-plan .link, .text-block .link').forEach((el) => observe(el, () => link(el, el.closest('.home-master-plan') ? 550 : 600)));
    const companyTop = document.querySelector('.home-company-details .top');
    observe(companyTop, () => {
      select('.top-item', companyTop).forEach((item, index) => {
        animate(item.querySelector('.item-head'), [{ opacity: 0 }, { opacity: 1 }], 2000, 500 + index * 150);
        animate(item.querySelector('.item-head-title'), [{ opacity: 0, transform: 'translateY(40px)' }, { opacity: 1 - index * .2, transform: 'translateY(0)' }], 1000, 500 + index * 150, OUT);
        animate(item.querySelector('.item-head-line'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], 1500, 500 + index * 150, OUT);
      });
    });
    const companyBottom = document.querySelector('.home-company-details .bottom');
    observe(companyBottom, () => {
      select('.bottom-items > *', companyBottom).forEach((el, index) => animate(el, [{ opacity: 0, transform: 'translateY(40px)' }, { opacity: 1, transform: 'translateY(0)' }], 1000, index * 100, OUT));
      animate(companyBottom.querySelector('.bottom-line'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], 1200, 150, OUT);
      animate(companyBottom.querySelector('.bottom-services'), [{ opacity: 0, transform: 'translateY(40px)' }, { opacity: 1, transform: 'translateY(0)' }], 1000, 300, OUT);
    }, .5);

    const onClick = (event) => {
      if (event.target.closest('.home-hero-scroll-indicator')) document.querySelector('.home-intro')?.scrollIntoView({ behavior });
      if (event.target.closest('.sticky-logo button')) window.scrollTo({ top: 0, behavior });
    };
    document.addEventListener('click', onClick);
    cleanups.push(() => document.removeEventListener('click', onClick));

    const images = select('.home-products .images-inner > .image-wrapper');
    const pills = select('.home-products .links .pill');
    let activeImage = 0;
    let swapping = false;
    images.forEach((el, index) => {
      el.style.display = 'block';
      el.classList.add('baseline-product-image');
      el.classList.toggle('baseline-product-active', index === 0);
      el.setAttribute('aria-hidden', index === 0 ? 'false' : 'true');
    });
    const selectImage = (index) => {
      if (index === activeImage || swapping || !images[index]) return;
      swapping = !reduced;
      const previous = images[activeImage];
      activeImage = index;
      animate(previous, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.85)' }], 400, 0, IN);
      images[index].classList.add('baseline-product-active');
      const entering = animate(images[index], [{ opacity: 0, transform: 'scale(1.15)' }, { opacity: 1, transform: 'scale(1)' }], 400, 300, OUT);
      const finish = () => { previous.classList.remove('baseline-product-active'); swapping = false; };
      if (entering) entering.onfinish = finish;
      else finish();
      images.forEach((el, imageIndex) => el.setAttribute('aria-hidden', imageIndex === index ? 'false' : 'true'));
      pills.forEach((el, pillIndex) => el.classList.toggle('filled', pillIndex === index));
    };
    pills.forEach((el, index) => {
      const parent = el.parentElement;
      const enter = () => selectImage(index);
      parent.addEventListener('mouseenter', enter);
      parent.addEventListener('focus', enter);
      cleanups.push(() => { parent.removeEventListener('mouseenter', enter); parent.removeEventListener('focus', enter); });
    });
    // The source uses scroll progress for this parallax, never a timed carousel.
    const product = document.querySelector('.home-products');
    const imageGroup = product?.querySelector('.images-inner');
    const parallax = () => {
      if (reduced || !product || !imageGroup) return;
      const rect = product.getBoundingClientRect();
      const progress = Math.max(0, Math.min(1, (window.innerHeight - rect.top) / (window.innerHeight + rect.height)));
      imageGroup.style.transform = `translateY(${-50 + progress * 100}px)`;
    };
    parallax();
    window.addEventListener('scroll', parallax, { passive: true });
    window.addEventListener('resize', parallax);
    cleanups.push(() => { window.removeEventListener('scroll', parallax); window.removeEventListener('resize', parallax); });
    const lines = select('.home-intro .copy-lines-wrapper .line');
    let activeLine = 0;
    const copyRotation = reduced ? null : window.setInterval(() => {
      const rect = intro?.getBoundingClientRect();
      if (!lines.length || !rect || rect.top >= window.innerHeight || rect.bottom <= 0) return;
      const previous = lines[activeLine];
      activeLine = (activeLine + 1) % lines.length;
      const next = lines[activeLine];
      next.style.display = 'block';
      title(next);
      previous.classList.remove('baseline-visible');
      const leaving = animate(previous, [{ opacity: 1 }, { opacity: 0 }], 500);
      if (leaving) leaving.onfinish = () => { previous.style.display = 'none'; leaving.cancel(); };
    }, 3500);

    // StickyLogo's source visibility bounds and section midpoint theme switching.
    const sticky = document.querySelector('.sticky-logo');
    const stickyInner = sticky?.querySelector('.inner');
    const stickyButton = sticky?.querySelector('button');
    const contact = document.querySelector('.text-block');
    let stickyVisible = null;
    let stickyAnimation;
    const updateSticky = () => {
      if (!sticky || !stickyInner || !stickyButton || !contact) return;
      const height = window.innerHeight;
      const section = select('main > .section').find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top <= height / 2 && rect.bottom >= height / 2;
      });
      // Added glass sections use the full grid: keep the inherited marker
      // out of their controls. Original source sections retain their behavior.
      const visible = sticky.getBoundingClientRect().top <= -height / 3
        && contact.getBoundingClientRect().bottom - height - height / 3 >= 0
        && !section?.classList.contains('zk-extension');
      const isBlue = section?.classList.contains('home-master-plan');
      const isDarkIcon = section?.classList.contains('home-company-details') || section?.classList.contains('home-about');
      sticky.classList.toggle('background-off-white', !!isBlue);
      sticky.classList.toggle('background-blue', !isBlue);
      sticky.classList.toggle('icon-blue', !!isBlue);
      sticky.classList.toggle('icon-off-black', !!isDarkIcon);
      sticky.classList.toggle('icon-off-white', !isBlue && !isDarkIcon);
      if (visible === stickyVisible) return;
      stickyVisible = visible;
      stickyAnimation?.cancel();
      if (visible) {
        stickyInner.style.display = 'flex';
        stickyAnimation = animate(stickyButton, [{ opacity: 0 }, { opacity: 1 }], 500, 0, OUT);
      } else {
        stickyAnimation = animate(stickyButton, [{ opacity: 1 }, { opacity: 0 }], 500, 100, OUT);
        if (stickyAnimation) stickyAnimation.onfinish = () => { if (!stickyVisible) stickyInner.style.display = 'none'; };
        else stickyInner.style.display = 'none';
      }
    };
    updateSticky();
    window.addEventListener('scroll', updateSticky, { passive: true });
    window.addEventListener('resize', updateSticky);
    cleanups.push(() => { window.removeEventListener('scroll', updateSticky); window.removeEventListener('resize', updateSticky); });

    return () => {
      observers.forEach((observer) => observer.disconnect());
      animations.forEach((animation) => animation.cancel());
      cleanups.forEach((cleanup) => cleanup());
      if (copyRotation) clearInterval(copyRotation);
      // Restore the exact original nodes React owns, not newly created copies.
      splitTextRecords.forEach(({ original, start, end }) => {
        if (!start.parentNode || start.parentNode !== end.parentNode) return;
        let node = start.nextSibling;
        while (node && node !== end) { const next = node.nextSibling; node.remove(); node = next; }
        start.replaceWith(original);
        end.remove();
      });
      shownElements.forEach((el) => el.classList.remove('baseline-visible'));
      revealNames.forEach((label, el) => { if (label === null) el.removeAttribute('aria-label'); else el.setAttribute('aria-label', label); });
    };
  }, []);
}
