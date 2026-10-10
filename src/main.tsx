import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { applyAppTheme, readAppTheme } from './appAppearance';
applyAppTheme(readAppTheme());
import { ErrorBoundary } from './ErrorBoundary';
import { parseWorkroomPopout } from './workroomPopout';

// A Workroom pop-out window loads this same bundle with a strict query
// (src/workroomPopout.ts) and renders only the Workroom, never the whole app.
const workroomPopout = parseWorkroomPopout(window.location.search);
const WorkroomPopoutApp = workroomPopout
  ? React.lazy(() => import('./WorkroomPopoutApp').then(module => ({ default: module.WorkroomPopoutApp })))
  : null;

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      {workroomPopout && WorkroomPopoutApp
        ? <React.Suspense fallback={null}><WorkroomPopoutApp route={workroomPopout} /></React.Suspense>
        : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
