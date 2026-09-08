import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { applyAppTheme, readAppTheme } from './appAppearance';
applyAppTheme(readAppTheme());
import { ErrorBoundary } from './ErrorBoundary';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
