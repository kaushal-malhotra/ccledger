/**
 * Mounts the dashboard. Nothing else belongs here — `index.html` ships a single
 * empty `#root`, and every decision about what goes in it is in `App.tsx`.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html is missing its #root element');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
