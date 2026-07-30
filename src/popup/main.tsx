import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { RuntimeMessageSender } from '../shared/messages';
import { createRuntimeMessageSender } from '../shared/messages';
import type {
  RuntimeRequestClient,
} from '../../apps/extension/src/capabilities/contracts';
import './styles.css';

export function mountPopup(options: {
  runtimeRequests: RuntimeRequestClient;
  extensionVersion: string;
}): void {
  const sendMessage: RuntimeMessageSender = createRuntimeMessageSender(
    options.runtimeRequests,
  );
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App
        sendMessage={sendMessage}
        extensionVersion={options.extensionVersion}
      />
    </React.StrictMode>,
  );
}
