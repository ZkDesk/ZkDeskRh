import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

const SoundContext = createContext(null);
export function SoundProvider({children}) {
  const [enabled,setEnabled] = useState(()=> {try{return localStorage.getItem('zkdesk.sound') !== 'off';}catch{return true;}});
  const context = useRef(null);
  useEffect(()=> {
    try {localStorage.setItem('zkdesk.sound',enabled?'on':'off');} catch {}
    if (!enabled) return;
    const play = event => {
      const control = event.target.closest('button,a,summary,[role="tab"]');
      if (!control || control.disabled || control.dataset.silent !== undefined) return;
      try {
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!Audio) return;
        context.current ||= new Audio();
        const ctx = context.current;
        if (ctx.state === 'suspended') ctx.resume();
        const t = ctx.currentTime;
        const isNav = control.tagName === 'A' || control.getAttribute('role') === 'tab';
        for (const [frequency, gain, offset] of [[isNav?880:1180,.023,0],[isNav?1320:1760,.008,.012]]) {
          const tone=ctx.createOscillator(), envelope=ctx.createGain();
          tone.type='sine'; tone.frequency.setValueAtTime(frequency,t+offset);
          tone.frequency.exponentialRampToValueAtTime(frequency*.82,t+offset+.055);
          envelope.gain.setValueAtTime(0,t+offset);
          envelope.gain.linearRampToValueAtTime(gain,t+offset+.004);
          envelope.gain.exponentialRampToValueAtTime(.0001,t+offset+.09);
          tone.connect(envelope); envelope.connect(ctx.destination);
          tone.start(t+offset); tone.stop(t+offset+.095);
        }
      } catch { /* The interface remains usable if browser audio is unavailable. */ }
    };
    document.addEventListener('click',play);
    return ()=>document.removeEventListener('click',play);
  },[enabled]);
  return <SoundContext.Provider value={{enabled,setEnabled}}>{children}</SoundContext.Provider>;
}

export function SoundToggle({className=''}) {
  const sound=useContext(SoundContext);
  if(!sound) return null;
  return <button className={`zk-sound ${className}`} type="button" aria-label={sound.enabled?'Mute interface sounds':'Enable interface sounds'} aria-pressed={sound.enabled} onClick={()=>sound.setEnabled(!sound.enabled)} title={sound.enabled?'Sound on':'Sound off'}>
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>{sound.enabled?<><path d="M15 8c2.7 2.2 2.7 5.8 0 8M18 5c4.5 4 4.5 10 0 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></>:<path d="m16 9 6 6m0-6-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>}</svg><span>{sound.enabled?'Sound on':'Sound off'}</span>
  </button>;
}
