import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { installTrustedTypesPolicy } from './runtime/trustedTypes';
import './styles.css';

installTrustedTypesPolicy();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
