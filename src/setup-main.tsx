import React from 'react';
import { createRoot } from 'react-dom/client';
import SetupWizard from './SetupWizard';
import './index.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <SetupWizard
    onComplete={() => {}}
    onSkip={() => {}}
  />
);
