import React from 'react';
import { createRoot } from 'react-dom/client';
import BrandSite from './brand/BrandSite.jsx';
import Docs from './Docs.jsx';
import Dashboard from './dashboard/Dashboard.jsx';
import {SoundProvider, SoundToggle} from './InteractionSound.jsx';
import {ProductCards,HowItWorks,RoadmapSection,QuestionsSection} from './extensions/LandingExtensions.jsx';
import './baseline/source.css';
import './baseline/interactions.css';
import './brand/brand.css';
import './shared.css';

const pathname = location.pathname.replace(/\/+$/,'') || '/';
const isDocs = pathname === '/docs';
const isDesk = pathname === '/dashboard';
document.title = isDocs ? 'ZKdesk — Documentation' : isDesk ? 'ZKdesk — Dashboard' : 'ZKdesk — Your balance. Private.';
const view = isDocs ? <Docs /> : isDesk ? <Dashboard/> : pathname === '/' ? <><BrandSite enhanced afterProducts={<><ProductCards/><HowItWorks/></>} afterAbout={<><RoadmapSection/><QuestionsSection/></>} /><SoundToggle className="zk-sound-float" /></> : <div className="zk-not-found"><span>ZKdesk</span><h1>This page isn’t on your desk.</h1><p>Return to the site or open your workspace.</p><a href="/">Back to site ↗</a><a href="/dashboard">Open workspace ↗</a></div>;
createRoot(document.getElementById('root')).render(<SoundProvider>{view}</SoundProvider>);
