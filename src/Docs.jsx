import React, { lazy, Suspense } from 'react';
// Kept so the main CSS bundle is byte-identical; the documentation itself ships as its own chunk.
import './docs.css';

const DeveloperDocs = lazy(() => import('./devdocs/DeveloperDocs.jsx'));

export default function Docs() {
  return <Suspense fallback={<div style={{ minHeight: '100vh', background: '#fff' }} />}><DeveloperDocs /></Suspense>;
}
