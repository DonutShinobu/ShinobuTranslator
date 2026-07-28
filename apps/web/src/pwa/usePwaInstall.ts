import {
  useCallback,
  useEffect,
  useState,
} from 'react';

const DISMISSED_AT_KEY = 'shinobu:pwa-install-dismissed-at:v1';
const DISMISS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type InstallChoice = {
  outcome: 'accepted' | 'dismissed';
  platform: string;
};

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<InstallChoice>;
}

export type PwaInstall = {
  installed: boolean;
  nativeAvailable: boolean;
  suggestionVisible: boolean;
  platform: 'ios' | 'other';
  requestInstall(): Promise<void>;
  offerAfterSuccess(): void;
  dismissSuggestion(): void;
};

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function dismissedRecently(): boolean {
  try {
    const timestamp = Number(localStorage.getItem(DISMISSED_AT_KEY));
    return Number.isFinite(timestamp) && Date.now() - timestamp < DISMISS_WINDOW_MS;
  } catch {
    return false;
  }
}

function rememberDismissal(): void {
  try {
    localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
  } catch {
    // The current page can still hide the prompt when storage is blocked.
  }
}

export function usePwaInstall(): PwaInstall {
  const [installed, setInstalled] = useState(isStandalone);
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent>();
  const [suggestionVisible, setSuggestionVisible] = useState(false);
  const platform = /iPad|iPhone|iPod/iu.test(navigator.userAgent) ? 'ios' : 'other';

  useEffect(() => {
    const handleBeforeInstall = (event: Event): void => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const handleInstalled = (): void => {
      setInstalled(true);
      setPromptEvent(undefined);
      setSuggestionVisible(false);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  const dismissSuggestion = useCallback((): void => {
    rememberDismissal();
    setSuggestionVisible(false);
  }, []);

  const requestInstall = useCallback(async (): Promise<void> => {
    if (installed) return;
    if (!promptEvent) {
      setSuggestionVisible(true);
      return;
    }
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    setPromptEvent(undefined);
    setSuggestionVisible(false);
    if (choice.outcome === 'accepted') setInstalled(true);
    else rememberDismissal();
  }, [installed, promptEvent]);

  const offerAfterSuccess = useCallback((): void => {
    if (!installed && !dismissedRecently()) setSuggestionVisible(true);
  }, [installed]);

  return {
    installed,
    nativeAvailable: Boolean(promptEvent),
    suggestionVisible,
    platform,
    requestInstall,
    offerAfterSuccess,
    dismissSuggestion,
  };
}
