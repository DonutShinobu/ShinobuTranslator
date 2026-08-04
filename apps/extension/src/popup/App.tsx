import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  defaultExtensionSettings,
  geminiAppModelOptions,
  llmBuiltInProviderDefinitions,
  llmProviderOptions,
  normalizeSettings,
  optimizedGeminiAppPromptTemplate,
  usesGeminiApiImagePipeline,
  usesGeminiAppImagePipeline,
  usesNanoBananaImagePipeline,
  type LlmAuthMode,
  type LlmProviderProfile,
  type LlmProvider,
  type ExtensionSettings,
} from '../shared/config';
import { getExtensionRuntime } from '../shared/extensionRuntime';
import {
  getLlmThinkingControl,
  llmThinkingCapabilityKey,
  resolveLlmThinkingLevel,
  type LlmThinkingLevel,
} from '@shinobu/text-translation';
import { sendRuntimeMessage } from '../shared/messages';
import { downloadText } from '../shared/utils';

type SaveStatus = {
  kind: 'idle' | 'saving' | 'success' | 'error';
  message: string;
};

type OpenAiOAuthViewState = {
  loading: boolean;
  busy: boolean;
  authenticated: boolean;
  pending: boolean;
  email?: string;
  planType?: string;
  error: string;
};

type PersistSettingsOptions = {
  silent?: boolean;
};

type SettingsUpdateOptions = {
  showSaveStatus?: boolean;
};

const IconGitHub = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.603-3.369-1.342-3.369-1.342-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
  </svg>
);

const IconTranslate = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 8 6 6" />
    <path d="m4 14 6-6 2-3" />
    <path d="M2 5h12" />
    <path d="m22 22-5-10-5 10" />
    <path d="M14 18h6" />
  </svg>
);

const IconLLM = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </svg>
);

const IconMode = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 4h-7" />
    <path d="M10 4H3" />
    <path d="M21 12h-9" />
    <path d="M8 12H3" />
    <path d="M21 20h-5" />
    <path d="M12 20H3" />
    <circle cx="12" cy="4" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="14" cy="20" r="2" />
  </svg>
);

const IconDownload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
);

const IconTrash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
);

const IconDebug = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.5-3.5a6 6 0 0 1-7.9 7.9l-6.6 6.6a2.1 2.1 0 0 1-3-3l6.6-6.6a6 6 0 0 1 7.9-7.9l-3.5 3.5z" />
  </svg>
);

const IconRefresh = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 0 1-15.5 6.2" />
    <path d="M3 12A9 9 0 0 1 18.5 5.8" />
    <path d="M18 3v6h-6" />
    <path d="M6 21v-6h6" />
  </svg>
);

const IconEye = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.1 12s3.6-7 9.9-7 9.9 7 9.9 7-3.6 7-9.9 7-9.9-7-9.9-7Z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

const IconEyeOff = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.1 12s3.6-7 9.9-7 9.9 7 9.9 7-3.6 7-9.9 7-9.9-7-9.9-7Z" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="m3 3 18 18" />
  </svg>
);

const shortcutCommandDefinitions = [
  { name: 'start-screenshot-translate', label: '截图翻译' },
  { name: 'translate-hover-target', label: '翻译悬停元素' },
] as const;

type ShortcutCommandName = typeof shortcutCommandDefinitions[number]['name'];
type ShortcutCommandInfo = {
  name?: string;
  shortcut?: string;
};
type ShortcutState = Record<ShortcutCommandName, string>;

const defaultShortcutState: ShortcutState = {
  'start-screenshot-translate': '',
  'translate-hover-target': '',
};

const geminiAppAuthCacheKey = 'shinobu.geminiApp.authenticated';

function readGeminiAppAuthCache(): boolean {
  try {
    return window.localStorage.getItem(geminiAppAuthCacheKey) === 'true';
  } catch {
    return false;
  }
}

function writeGeminiAppAuthCache(authenticated: boolean): void {
  try {
    window.localStorage.setItem(geminiAppAuthCacheKey, authenticated ? 'true' : 'false');
  } catch {
    // Cache is a UI hint only; failure should not block login or settings.
  }
}

function ApiKeyField({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const inputId = useId();
  const toggleLabel = revealed ? '隐藏 API Key' : '显示 API Key';

  return (
    <div className="field">
      <label className="field-label" htmlFor={inputId}>API Key</label>
      <div className="api-key-control">
        <input
          id={inputId}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={placeholder}
        />
        <button
          className="api-key-visibility-button"
          type="button"
          onClick={() => setRevealed((current) => !current)}
          disabled={disabled}
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-controls={inputId}
          aria-pressed={revealed}
        >
          {revealed ? <IconEye /> : <IconEyeOff />}
        </button>
      </div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const count = options.length;
  return (
    <div className={`seg-control${disabled ? ' seg-disabled' : ''}`}>
      <div
        className="seg-pill"
        style={{
          width: `calc(${100 / count}% - ${6 / count}px)`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          className={`seg-option${i === selectedIndex ? ' seg-active' : ''}`}
          onClick={() => onChange(option.value)}
          disabled={disabled}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type SelectOption<T extends string> = {
  value: T;
  label: string;
};

type SelectPlacement = 'down' | 'up';

const selectCurrentValueIndex = -1;
const selectRowHeight = 31;
const selectMenuMaxHeight = 191;
const selectMenuChromeHeight = 1;

function SelectControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectCurrentValueIndex);
  const [placement, setPlacement] = useState<SelectPlacement>('down');
  const [menuMaxHeight, setMenuMaxHeight] = useState(selectMenuMaxHeight);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const generatedId = useId();
  const listboxId = `select-listbox-${generatedId}`;
  const selectedOption = options.find((option) => option.value === value) ?? options[0];
  const availableOptions = options.filter((option) => option.value !== value);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open || activeIndex === selectCurrentValueIndex) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function getVisualOptionIndices(targetPlacement: SelectPlacement): number[] {
    const optionIndices = availableOptions.map((_, index) => index);
    return targetPlacement === 'down'
      ? [selectCurrentValueIndex, ...optionIndices]
      : [...optionIndices, selectCurrentValueIndex];
  }

  function openMenu(): SelectPlacement | null {
    if (availableOptions.length === 0) return null;

    const triggerRect = triggerRef.current?.getBoundingClientRect();
    const popupRect = rootRef.current?.closest('.popup')?.getBoundingClientRect();
    let nextPlacement = placement;
    if (triggerRect) {
      const boundaryTop = Math.max(0, popupRect?.top ?? 0);
      const boundaryBottom = Math.min(window.innerHeight, popupRect?.bottom ?? window.innerHeight);
      const spaceAbove = Math.max(0, triggerRect.top - boundaryTop);
      const spaceBelow = Math.max(0, boundaryBottom - triggerRect.bottom);
      const desiredHeight = Math.min(
        selectMenuMaxHeight,
        availableOptions.length * selectRowHeight + selectMenuChromeHeight,
      );
      nextPlacement =
        spaceBelow >= desiredHeight || spaceBelow >= spaceAbove ? 'down' : 'up';
      const availableHeight = nextPlacement === 'down' ? spaceBelow : spaceAbove;

      setPlacement(nextPlacement);
      setMenuMaxHeight(Math.max(
        selectRowHeight + selectMenuChromeHeight,
        Math.min(selectMenuMaxHeight, Math.floor(availableHeight)),
      ));
    }

    setActiveIndex(selectCurrentValueIndex);
    setOpen(true);
    return nextPlacement;
  }

  function closeMenu(restoreFocus = false): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function selectOption(index: number): void {
    if (index === selectCurrentValueIndex) {
      closeMenu(true);
      return;
    }
    const option = availableOptions[index];
    if (!option) return;
    onChange(option.value);
    closeMenu(true);
  }

  function moveActiveOption(direction: 1 | -1): void {
    if (!open) {
      openMenu();
      return;
    }
    if (availableOptions.length === 0) return;
    const visualIndices = getVisualOptionIndices(placement);
    setActiveIndex((current) => {
      const currentPosition = visualIndices.indexOf(current);
      const nextPosition = (
        Math.max(0, currentPosition) + direction + visualIndices.length
      ) % visualIndices.length;
      return visualIndices[nextPosition];
    });
  }

  function moveActiveToBoundary(boundary: 'start' | 'end'): void {
    const targetPlacement = open ? placement : openMenu();
    if (!targetPlacement) return;
    const visualIndices = getVisualOptionIndices(targetPlacement);
    setActiveIndex(boundary === 'start' ? visualIndices[0] : visualIndices[visualIndices.length - 1]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActiveOption(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActiveOption(-1);
        break;
      case 'Home':
        event.preventDefault();
        moveActiveToBoundary('start');
        break;
      case 'End':
        event.preventDefault();
        moveActiveToBoundary('end');
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) selectOption(activeIndex);
        else openMenu();
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          closeMenu();
        }
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const query = event.key.toLocaleLowerCase();
          const availableMatchIndex = availableOptions.findIndex(
            (option) => option.label.toLocaleLowerCase().startsWith(query),
          );
          const matchIndex = selectedOption?.label.toLocaleLowerCase().startsWith(query)
            ? selectCurrentValueIndex
            : availableMatchIndex >= 0
              ? availableMatchIndex
              : null;
          if (matchIndex !== null) {
            event.preventDefault();
            if (!open) openMenu();
            setActiveIndex(matchIndex);
          }
        }
    }
  }

  return (
    <div
      className="select-root"
      data-open={open}
      data-placement={placement}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger${
          open && activeIndex === selectCurrentValueIndex ? ' select-trigger-active' : ''
        }`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open && activeIndex !== selectCurrentValueIndex
            ? `${listboxId}-option-${activeIndex}`
            : undefined
        }
        disabled={disabled}
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={handleKeyDown}
        onPointerMove={() => {
          if (open) setActiveIndex(selectCurrentValueIndex);
        }}
      >
        <span className="select-value">{selectedOption?.label ?? ''}</span>
        <svg
          className="select-chevron"
          viewBox="0 0 12 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m1.5 1.5 4.5 4.5 4.5-4.5" />
        </svg>
      </button>
      <div
        className="select-menu"
        aria-hidden={!open}
      >
        <div
          id={listboxId}
          className="select-options-scroll"
          role="listbox"
          aria-label={ariaLabel}
          style={{
            maxHeight: Math.max(selectRowHeight, menuMaxHeight - selectMenuChromeHeight),
          }}
        >
          {availableOptions.map((option, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                className={`select-option${active ? ' select-option-active' : ''}`}
                role="option"
                aria-selected="false"
                tabIndex={-1}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => selectOption(index)}
              >
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(defaultExtensionSettings);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle', message: '' });
  const [shortcutsLoading, setShortcutsLoading] = useState(true);
  const [shortcuts, setShortcuts] = useState<ShortcutState>(defaultShortcutState);
  const [shortcutError, setShortcutError] = useState('');
  const [thinkingFillReturningToOffKey, setThinkingFillReturningToOffKey] = useState<string | null>(null);
  const [openAiStatus, setOpenAiStatus] = useState<OpenAiOAuthViewState>({
    loading: false,
    busy: false,
    authenticated: false,
    pending: false,
    error: '',
  });
  const [geminiAppStatus, setGeminiAppStatus] = useState<OpenAiOAuthViewState>({
    loading: false,
    busy: false,
    authenticated: readGeminiAppAuthCache(),
    pending: false,
    error: '',
  });
  const hasHydratedRef = useRef(false);
  const geminiAppAutoCheckAttemptedRef = useRef(false);
  const nextSaveShowsStatusRef = useRef(false);
  const saveRequestIdRef = useRef(0);

  useEffect(() => {
    async function loadSettings(): Promise<void> {
      try {
        const response = await sendRuntimeMessage({ type: 'mt:get-settings' });
        if (!response.ok || response.type !== 'mt:get-settings') {
          throw new Error(response.ok ? '读取配置失败' : response.error);
        }
        setSettings(normalizeSettings(response.settings));
      } catch (error) {
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setLoading(false);
      }
    }
    void loadSettings();
  }, []);

  useEffect(() => {
    async function loadShortcuts(): Promise<void> {
      setShortcutsLoading(true);
      setShortcutError('');
      const runtime = getExtensionRuntime();
      if (!runtime) {
        setShortcutError('当前浏览器不支持读取扩展命令');
        setShortcutsLoading(false);
        return;
      }
      try {
        const commands = await runtime.getCommands() as ShortcutCommandInfo[];
        const nextShortcuts: ShortcutState = { ...defaultShortcutState };
        for (const commandDefinition of shortcutCommandDefinitions) {
          const command = commands.find((item) => item.name === commandDefinition.name);
          nextShortcuts[commandDefinition.name] = command?.shortcut ?? '';
        }
        setShortcuts(nextShortcuts);
      } catch (error) {
        setShortcutError(error instanceof Error ? error.message : String(error));
      } finally {
        setShortcutsLoading(false);
      }
    }
    void loadShortcuts();
  }, []);

  function queueSaveStatus(options: SettingsUpdateOptions = {}): void {
    nextSaveShowsStatusRef.current = nextSaveShowsStatusRef.current || options.showSaveStatus === true;
  }

  function applyNanoBananaDebugLocks(next: ExtensionSettings): ExtensionSettings {
    if (!usesNanoBananaImagePipeline(next)) return next;
    return {
      ...next,
      showStageTimingDetails: false,
      showTypesetDebug: false,
      showEraseDebug: false,
      disableOcrPostFilter: false,
    };
  }

  function updateField<K extends keyof ExtensionSettings>(
    key: K,
    value: ExtensionSettings[K],
    options?: SettingsUpdateOptions,
  ): void {
    queueSaveStatus(options);
    setSettings((prev) => applyNanoBananaDebugLocks({
      ...prev,
      [key]: value,
    }));
  }

  function updateElapsedTime(checked: boolean, options?: SettingsUpdateOptions): void {
    queueSaveStatus(options);
    setSettings((prev) => applyNanoBananaDebugLocks({
      ...prev,
      showElapsedTime: checked,
      showStageTimingDetails: checked && !usesNanoBananaImagePipeline(prev) ? prev.showStageTimingDetails : false,
    }));
  }

  function updateActiveLlmProfile(patch: Partial<LlmProviderProfile>, options?: SettingsUpdateOptions): void {
    queueSaveStatus(options);
    setSettings((prev) => ({
      ...prev,
      llmProfiles: {
        ...prev.llmProfiles,
        [prev.llmProvider]: {
          ...prev.llmProfiles[prev.llmProvider],
          ...patch,
        },
      },
    }));
  }

  function updateTranslator(translator: ExtensionSettings['translator']): void {
    queueSaveStatus();
    setSettings((prev) => applyNanoBananaDebugLocks({
      ...prev,
      translator,
      showStageTimingDetails: usesNanoBananaImagePipeline({ translator, llmProvider: prev.llmProvider })
        ? false
        : prev.showStageTimingDetails,
    }));
  }

  function updateLlmProvider(provider: LlmProvider): void {
    queueSaveStatus();
    setSettings((prev) => applyNanoBananaDebugLocks({
      ...prev,
      llmProvider: provider,
      showStageTimingDetails: usesNanoBananaImagePipeline({ translator: prev.translator, llmProvider: provider })
        ? false
        : prev.showStageTimingDetails,
    }));
  }

  function updateUseCustomModel(checked: boolean): void {
    updateActiveLlmProfile({ useCustomModel: checked });
  }

  function updateThinkingLevel(provider: LlmProvider, model: string, level: LlmThinkingLevel): void {
    const capabilityKey = llmThinkingCapabilityKey(provider, model);
    setThinkingFillReturningToOffKey(level === 'off' ? capabilityKey : null);
    queueSaveStatus();
    setSettings((prev) => ({
      ...prev,
      llmThinkingByModel: {
        ...prev.llmThinkingByModel,
        [capabilityKey]: level,
      },
    }));
  }

  function resetGeminiAppPromptTemplate(): void {
    updateField('geminiAppPromptTemplate', optimizedGeminiAppPromptTemplate, { showSaveStatus: true });
  }

  function applyOpenAiStatus(next: {
    authenticated: boolean;
    pending?: boolean;
    email?: string;
    planType?: string;
    error?: string;
  }): void {
    setOpenAiStatus({
      loading: false,
      busy: false,
      authenticated: next.authenticated,
      pending: next.pending ?? false,
      email: next.email,
      planType: next.planType,
      error: next.error ?? '',
    });
  }

  async function refreshOpenAiOAuthStatus(): Promise<void> {
    setOpenAiStatus((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const response = await sendRuntimeMessage({ type: 'mt:openai-oauth-status' });
      if (!response.ok || response.type !== 'mt:openai-oauth-status') {
        throw new Error(response.ok ? '读取 OpenAI 登录状态失败' : response.error);
      }
      applyOpenAiStatus(response.status);
    } catch (error) {
      setOpenAiStatus({
        loading: false,
        busy: false,
        authenticated: false,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function loginOpenAiOAuth(): Promise<void> {
    setOpenAiStatus((prev) => ({ ...prev, busy: true, error: '' }));
    try {
      const response = await sendRuntimeMessage({ type: 'mt:openai-oauth-login' });
      if (!response.ok || response.type !== 'mt:openai-oauth-login') {
        throw new Error(response.ok ? 'OpenAI 登录失败' : response.error);
      }
      applyOpenAiStatus(response.status);
      setStatus({
        kind: 'success',
        message: response.status.authenticated ? 'OpenAI 已登录' : 'OpenAI 登录页已打开，请在新标签页完成授权',
      });
    } catch (error) {
      setOpenAiStatus((prev) => ({
        ...prev,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async function logoutOpenAiOAuth(): Promise<void> {
    setOpenAiStatus((prev) => ({ ...prev, busy: true, error: '' }));
    try {
      const response = await sendRuntimeMessage({ type: 'mt:openai-oauth-logout' });
      if (!response.ok || response.type !== 'mt:openai-oauth-logout') {
        throw new Error(response.ok ? 'OpenAI 退出登录失败' : response.error);
      }
      applyOpenAiStatus(response.status);
      setStatus({ kind: 'success', message: 'OpenAI 已退出登录' });
    } catch (error) {
      setOpenAiStatus((prev) => ({
        ...prev,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  function applyGeminiAppStatus(next: {
    authenticated: boolean;
    pending?: boolean;
    error?: string;
  }): void {
    writeGeminiAppAuthCache(next.authenticated);
    setGeminiAppStatus({
      loading: false,
      busy: false,
      authenticated: next.authenticated,
      pending: next.pending ?? false,
      error: next.error ?? '',
    });
  }

  async function refreshGeminiAppAuthStatus(): Promise<void> {
    geminiAppAutoCheckAttemptedRef.current = true;
    setGeminiAppStatus((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const response = await sendRuntimeMessage({ type: 'mt:gemini-app-auth-status' });
      if (!response.ok || response.type !== 'mt:gemini-app-auth-status') {
        throw new Error(response.ok ? '读取 Gemini 登录状态失败' : response.error);
      }
      applyGeminiAppStatus(response.status);
    } catch (error) {
      setGeminiAppStatus({
        loading: false,
        busy: false,
        authenticated: false,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function loginGeminiApp(): Promise<void> {
    setGeminiAppStatus((prev) => ({ ...prev, busy: true, error: '' }));
    try {
      const response = await sendRuntimeMessage({ type: 'mt:gemini-app-auth-login' });
      if (!response.ok || response.type !== 'mt:gemini-app-auth-login') {
        throw new Error(response.ok ? 'Gemini 登录失败' : response.error);
      }
      applyGeminiAppStatus(response.status);
      setStatus({
        kind: 'success',
        message: response.status.authenticated ? '登录状态已更新' : 'Gemini 登录页已打开，请在新标签页完成登录',
      });
    } catch (error) {
      setGeminiAppStatus((prev) => ({
        ...prev,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const currentProfile = settings.llmProfiles[settings.llmProvider];
  const usesNanoBanana = usesNanoBananaImagePipeline(settings);
  const usesGeminiApp = usesGeminiAppImagePipeline(settings);
  const usesGeminiApi = usesGeminiApiImagePipeline(settings);
  const currentProviderModels =
    settings.llmProvider === 'custom' || usesGeminiApp ? [] : llmBuiltInProviderDefinitions[settings.llmProvider].models;
  const builtInCustomModelPlaceholder = currentProviderModels[0] ?? currentProfile.modelPreset;
  const currentThinkingModel =
    settings.llmProvider !== 'custom' &&
    settings.llmProvider !== 'gemini' &&
    !currentProfile.useCustomModel
      ? currentProfile.modelPreset
      : null;
  const currentThinkingControl = currentThinkingModel
    ? getLlmThinkingControl(settings.llmProvider, currentThinkingModel)
    : null;
  const currentThinkingLevel = currentThinkingModel
    ? resolveLlmThinkingLevel(
        settings.llmThinkingByModel,
        settings.llmProvider,
        currentThinkingModel,
      )
    : undefined;
  const currentThinkingCapabilityKey = currentThinkingModel
    ? llmThinkingCapabilityKey(settings.llmProvider, currentThinkingModel)
    : null;
  const currentThinkingOptionIndex = currentThinkingControl?.kind === 'slider'
    ? Math.max(
        0,
        currentThinkingControl.options.findIndex((option) => option.value === currentThinkingLevel),
      )
    : 0;
  const currentThinkingOptionProgress = currentThinkingControl?.kind === 'slider'
    && currentThinkingControl.options.length > 1
    ? (currentThinkingOptionIndex / (currentThinkingControl.options.length - 1)) * 100
    : 0;
  const currentThinkingFillHidden = currentThinkingOptionIndex === 0
    && thinkingFillReturningToOffKey !== currentThinkingCapabilityKey;
  const usesOpenAiOAuth = settings.llmProvider === 'openai' && currentProfile.authMode === 'openai_oauth';
  const showLocalPipelineOptions = !usesNanoBanana;
  const stageTimingDetailsLocked = usesNanoBanana;
  const stageTimingDetailsDisabled = loading || !settings.showElapsedTime || stageTimingDetailsLocked;
  const localDebugOptionsLocked = usesNanoBanana;
  const localDebugOptionsDisabled = loading || localDebugOptionsLocked;
  const openAiStatusLabel = openAiStatus.loading
    ? '正在检查 OpenAI 登录'
    : openAiStatus.authenticated
      ? openAiStatus.email ?? '已登录 OpenAI'
      : openAiStatus.error
        ? openAiStatus.error
        : openAiStatus.pending
          ? '等待 OpenAI 授权完成'
          : '未登录 OpenAI';
  const geminiStatusLabel = geminiAppStatus.loading
    ? '正在检查'
    : geminiAppStatus.authenticated
      ? 'Gemini已登录'
      : geminiAppStatus.error
        ? geminiAppStatus.error
        : geminiAppStatus.pending
          ? '未登录'
          : '未登录';
  const extensionRuntime = getExtensionRuntime();
  const extensionVersion = extensionRuntime?.getVersion() ?? '';

  function openShortcutManager(): void {
    if (!extensionRuntime) {
      setStatus({ kind: 'error', message: '无法打开扩展命令管理页' });
      return;
    }
    void extensionRuntime.openShortcutSettings().catch((error: unknown) => {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async function persistSettings(nextSettings: ExtensionSettings, options: PersistSettingsOptions = {}): Promise<void> {
    const requestId = saveRequestIdRef.current + 1;
    saveRequestIdRef.current = requestId;
    if (options.silent) {
      setStatus((prev) => (prev.kind === 'saving' || prev.kind === 'success' ? { kind: 'idle', message: '' } : prev));
    } else {
      setStatus({ kind: 'saving', message: '正在自动保存...' });
    }
    try {
      const response = await sendRuntimeMessage({
        type: 'mt:set-settings',
        settings: nextSettings,
      });
      if (!response.ok || response.type !== 'mt:set-settings') {
        throw new Error(response.ok ? '自动保存失败' : response.error);
      }
      if (!options.silent && saveRequestIdRef.current === requestId) {
        setStatus({ kind: 'success', message: '已自动保存' });
      }
    } catch (error) {
      if (saveRequestIdRef.current === requestId) {
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function downloadDiagnosticLog(): Promise<void> {
    setStatus({ kind: 'saving', message: '正在准备日志...' });
    try {
      const response = await sendRuntimeMessage({ type: 'mt:diagnostic-log-export' });
      if (!response.ok || response.type !== 'mt:diagnostic-log-export') {
        throw new Error(response.ok ? '导出日志失败' : response.error);
      }
      if (response.log.eventCount === 0) {
        setStatus({ kind: 'error', message: '暂无可下载日志，请先开启日志记录并执行一次翻译' });
        return;
      }
      downloadText(response.log.text, response.log.filenamePrefix);
      setStatus({ kind: 'success', message: '日志已下载' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function clearDiagnosticLog(): Promise<void> {
    if (!window.confirm('确定要清空已保存的诊断日志吗？')) {
      return;
    }

    setStatus({ kind: 'saving', message: '正在清空日志...' });
    try {
      const response = await sendRuntimeMessage({ type: 'mt:diagnostic-log-clear' });
      if (!response.ok || response.type !== 'mt:diagnostic-log-clear') {
        throw new Error(response.ok ? '清空日志失败' : response.error);
      }
      setStatus({ kind: 'success', message: '日志已清空' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  useEffect(() => {
    if (loading) {
      return;
    }
    if (!hasHydratedRef.current) {
      hasHydratedRef.current = true;
      return;
    }

    const showSaveStatus = nextSaveShowsStatusRef.current;
    nextSaveShowsStatusRef.current = false;
    void persistSettings(settings, { silent: !showSaveStatus });
  }, [loading, settings]);

  useEffect(() => {
    if (!usesOpenAiOAuth || !openAiStatus.pending) {
      return;
    }
    const intervalId = window.setInterval(() => {
      if (!openAiStatus.loading && !openAiStatus.busy) {
        void refreshOpenAiOAuthStatus();
      }
    }, 2_000);
    return () => window.clearInterval(intervalId);
  }, [usesOpenAiOAuth, openAiStatus.pending, openAiStatus.loading, openAiStatus.busy]);

  useEffect(() => {
    if (loading) {
      return;
    }
    if (!usesGeminiApp) {
      geminiAppAutoCheckAttemptedRef.current = false;
      return;
    }
    if (
      geminiAppStatus.authenticated ||
      geminiAppStatus.loading ||
      geminiAppStatus.busy ||
      geminiAppStatus.pending ||
      geminiAppAutoCheckAttemptedRef.current
    ) {
      return;
    }
    geminiAppAutoCheckAttemptedRef.current = true;
    void refreshGeminiAppAuthStatus();
  }, [
    loading,
    usesGeminiApp,
    geminiAppStatus.authenticated,
    geminiAppStatus.loading,
    geminiAppStatus.busy,
    geminiAppStatus.pending,
  ]);

  useEffect(() => {
    if (!usesGeminiApp || !geminiAppStatus.pending) {
      return;
    }
    const intervalId = window.setInterval(() => {
      if (!geminiAppStatus.loading && !geminiAppStatus.busy) {
        void refreshGeminiAppAuthStatus();
      }
    }, 2_000);
    return () => window.clearInterval(intervalId);
  }, [usesGeminiApp, geminiAppStatus.pending, geminiAppStatus.loading, geminiAppStatus.busy]);

  return (
    <main className="popup">
      {status.message ? (
        <div className={`status-bubble status-${status.kind}`}>{status.message}</div>
      ) : null}
      <header className="popup-header">
        <div className="popup-header-brand">
          <img className="popup-header-logo" src="icons/icon128.png" alt="" aria-hidden="true" />
          <div className="popup-header-text">
            <h1>
              <img className="popup-header-wordmark" src="brand/shinobu-wordmark.svg" alt="ShinobuTranslator" />
            </h1>
            <p className="subtitle">漫画图片翻译助手</p>
          </div>
        </div>
        <div className="popup-header-meta">
          <a
            className="popup-header-github"
            href="https://github.com/DonutShinobu/ShinobuTranslator"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
          >
            <IconGitHub />
          </a>
          {extensionVersion ? <span className="popup-header-version">v{extensionVersion}</span> : null}
        </div>
      </header>

      <div className="popup-body">
        {loading ? (
          <p className="loading-text">正在读取配置…</p>
        ) : (
          <>
            <section className="panel">
              <div className="panel-title panel-title-with-shortcuts">
                <span className="panel-title-copy">
                  <IconTranslate />
                  翻译设置
                </span>
                <button
                  className={`panel-title-shortcuts${shortcutError ? ' panel-title-shortcuts-error' : ''}`}
                  type="button"
                  onClick={openShortcutManager}
                  title={shortcutError || '打开 Chrome 扩展命令管理页'}
                  aria-label="管理扩展命令"
                >
                  {shortcutCommandDefinitions.map((definition) => {
                    const shortcut = shortcuts[definition.name];
                    return (
                      <span className="panel-title-shortcut-row" key={definition.name}>
                        <span className="panel-title-shortcut-label">{definition.label}</span>
                        <kbd className={`panel-title-shortcut-key${!shortcutsLoading && !shortcut ? ' panel-title-shortcut-key-unbound' : ''}`}>
                          {shortcutsLoading ? '读取中' : shortcut || '未绑定'}
                        </kbd>
                      </span>
                    );
                  })}
                </button>
              </div>
              <div className="settings-stack">
                <div className="setting-row">
                  <span className="field-label">服务</span>
                  <SegmentedControl
                    options={[
                      { value: 'google_web', label: '谷歌翻译' },
                      { value: 'llm', label: '大模型' },
                    ]}
                    value={settings.translator}
                    onChange={(value) => updateTranslator(value as ExtensionSettings['translator'])}
                    disabled={loading}
                  />
                </div>
                <div className="setting-row">
                  <span className="field-label">语言</span>
                  <SegmentedControl
                    options={[
                      { value: 'zh-CHS', label: '简体中文' },
                      { value: 'zh-CHT', label: '繁体中文' },
                    ]}
                    value={settings.targetLang}
                    onChange={(value) => updateField('targetLang', value)}
                    disabled={loading}
                  />
                </div>
              </div>
            </section>

            {showLocalPipelineOptions ? (
              <section className="panel option-panel">
                <div className="panel-title">
                  <IconMode />
                  模式
                </div>
                <SegmentedControl
                  options={[
                    { value: 'translate', label: '翻译' },
                    { value: 'original', label: '原文' },
                    { value: 'erase', label: '去字' },
                  ]}
                  value={settings.processMode}
                  onChange={(v) => updateField('processMode', v as ExtensionSettings['processMode'])}
                  disabled={loading}
                />
              </section>
            ) : null}

            {settings.translator === 'llm' ? (
              <section className="panel panel-llm">
                <div className="panel-title">
                  <IconLLM />
                  大模型配置
                </div>
                <div className="field">
                  <span className="field-label">LLM 提供商</span>
                  <SelectControl
                    ariaLabel="LLM 提供商"
                    options={llmProviderOptions}
                    value={settings.llmProvider}
                    onChange={updateLlmProvider}
                    disabled={loading}
                  />
                </div>

                {settings.llmProvider === 'gemini' ? (
                  <>
                    <div className="auth-mode-field">
                      <span className="field-label">认证方式</span>
                      <SegmentedControl<LlmAuthMode>
                        options={[
                          { value: 'gemini_app', label: 'Gemini 登录' },
                          { value: 'api_key', label: 'API Key' },
                        ]}
                        value={currentProfile.authMode}
                        onChange={(value) => updateActiveLlmProfile({ authMode: value })}
                        disabled={loading}
                      />
                    </div>
                    <div className="auth-mode-field">
                      <span className="field-label">模型</span>
                      <SegmentedControl<ExtensionSettings['geminiAppModel']>
                        options={geminiAppModelOptions}
                        value={settings.geminiAppModel}
                        onChange={(value) => updateField('geminiAppModel', value)}
                        disabled={loading}
                      />
                    </div>
                    {usesGeminiApp ? (
                      <>
                        <div className="auth-status-row">
                          <span className="field-label">登录状态</span>
                          <div className="auth-status-control">
                            <div className="oauth-copy">
                              <span className={`oauth-dot${geminiAppStatus.authenticated ? ' oauth-dot-authed' : ''}`} />
                              <div className="oauth-title">{geminiStatusLabel}</div>
                            </div>
                            <button
                              className="oauth-action"
                              type="button"
                              onClick={() => {
                                void (
                                  geminiAppStatus.authenticated || geminiAppStatus.pending
                                    ? refreshGeminiAppAuthStatus()
                                    : loginGeminiApp()
                                );
                              }}
                              disabled={loading || geminiAppStatus.loading || geminiAppStatus.busy}
                            >
                              {geminiAppStatus.busy
                                ? '处理中...'
                                : geminiAppStatus.authenticated || geminiAppStatus.pending
                                  ? '检查状态'
                                  : '登录 Gemini'}
                            </button>
                          </div>
                        </div>
                      </>
                    ) : null}
                    {usesGeminiApi ? (
                      <ApiKeyField
                        key={`api-key-${settings.llmProvider}-${currentProfile.authMode}`}
                        value={currentProfile.apiKey}
                        onChange={(value) =>
                          updateActiveLlmProfile({ apiKey: value }, { showSaveStatus: true })
                        }
                        disabled={loading}
                        placeholder="AIza..."
                      />
                    ) : null}
                    <div className="field">
                      <span className="field-label field-label-action">
                        <span>提示词</span>
                        <button
                          className="field-label-icon-button"
                          type="button"
                          onClick={resetGeminiAppPromptTemplate}
                          disabled={loading}
                          title="重置提示词"
                          aria-label="重置提示词"
                        >
                          <IconRefresh />
                        </button>
                      </span>
                      <textarea
                        value={settings.geminiAppPromptTemplate}
                        onChange={(event) =>
                          updateField('geminiAppPromptTemplate', event.target.value, { showSaveStatus: true })
                        }
                        disabled={loading}
                        rows={5}
                      />
                    </div>
                  </>
                ) : settings.llmProvider === 'custom' ? (
                  <>
                    <label className="field">
                      <span className="field-label">Base URL</span>
                      <input
                        type="text"
                        value={currentProfile.customBaseUrl}
                        onChange={(event) =>
                          updateActiveLlmProfile({ customBaseUrl: event.target.value }, { showSaveStatus: true })
                        }
                        disabled={loading}
                        placeholder="https://api.example.com/v1"
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">模型名称</span>
                      <input
                        type="text"
                        value={currentProfile.modelCustom}
                        onChange={(event) =>
                          updateActiveLlmProfile({ modelCustom: event.target.value }, { showSaveStatus: true })
                        }
                        disabled={loading}
                        placeholder="例如：your-model-name"
                      />
                    </label>
                    <ApiKeyField
                      key={`api-key-${settings.llmProvider}-${currentProfile.authMode}`}
                      value={currentProfile.apiKey}
                      onChange={(value) =>
                        updateActiveLlmProfile({ apiKey: value }, { showSaveStatus: true })
                      }
                      disabled={loading}
                      placeholder="sk-..."
                    />
                  </>
                ) : (
                  <>
                    {settings.llmProvider === 'openai' ? (
                      <div className="auth-mode-field">
                        <span className="field-label">认证方式</span>
                        <SegmentedControl<LlmAuthMode>
                          options={[
                            { value: 'openai_oauth', label: 'OpenAI 登录' },
                            { value: 'api_key', label: 'API Key' },
                          ]}
                          value={currentProfile.authMode}
                          onChange={(value) => updateActiveLlmProfile({ authMode: value })}
                          disabled={loading}
                        />
                      </div>
                    ) : null}
                    {usesOpenAiOAuth ? (
                      <div className="auth-status-row">
                        <span className="field-label">登录状态</span>
                        <div className="auth-status-control">
                          <div className="oauth-copy">
                            <span className={`oauth-dot${openAiStatus.authenticated ? ' oauth-dot-authed' : ''}`} />
                            <div className="oauth-title">{openAiStatusLabel}</div>
                          </div>
                          <button
                            className="oauth-action"
                            type="button"
                            onClick={() => {
                              void (
                                openAiStatus.authenticated
                                  ? logoutOpenAiOAuth()
                                  : openAiStatus.pending
                                    ? refreshOpenAiOAuthStatus()
                                    : loginOpenAiOAuth()
                              );
                            }}
                            disabled={loading || openAiStatus.loading || openAiStatus.busy}
                          >
                            {openAiStatus.busy
                              ? '处理中...'
                              : openAiStatus.authenticated
                                ? '退出登录'
                                : openAiStatus.pending
                                  ? '检查状态'
                                  : '登录 OpenAI'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    <div className="field model-field">
                      <span className="field-label">模型名称</span>
                      <div className="model-control">
                        {currentProfile.useCustomModel ? (
                          <input
                            type="text"
                            value={currentProfile.modelCustom}
                            onChange={(event) =>
                              updateActiveLlmProfile({ modelCustom: event.target.value }, { showSaveStatus: true })
                            }
                            disabled={loading}
                            placeholder={builtInCustomModelPlaceholder}
                          />
                        ) : (
                          <SelectControl
                            ariaLabel="模型名称"
                            options={currentProviderModels.map((model) => ({ value: model, label: model }))}
                            value={currentProfile.modelPreset}
                            onChange={(modelPreset) => updateActiveLlmProfile({ modelPreset })}
                            disabled={loading}
                          />
                        )}
                        <label className={`custom-model-toggle${loading ? ' custom-model-toggle-disabled' : ''}`}>
                          <input
                            type="checkbox"
                            checked={currentProfile.useCustomModel}
                            onChange={(event) => updateUseCustomModel(event.target.checked)}
                            disabled={loading}
                          />
                          <span>自定义</span>
                        </label>
                      </div>
                    </div>
                    {currentThinkingModel && currentThinkingControl && currentThinkingLevel ? (
                      <div className="field thinking-field">
                        <span className="field-label">思考强度</span>
                        {currentThinkingControl.kind === 'fixed' ? (
                          <span className="thinking-fixed-notice">{currentThinkingControl.notice}</span>
                        ) : currentThinkingControl.kind === 'toggle' ? (
                          <SegmentedControl<LlmThinkingLevel>
                            options={currentThinkingControl.options}
                            value={currentThinkingLevel}
                            onChange={(level) => updateThinkingLevel(
                              settings.llmProvider,
                              currentThinkingModel,
                              level,
                            )}
                            disabled={loading}
                          />
                        ) : (
                          <div className="thinking-slider-control">
                            <div className="thinking-slider-track">
                              <div className="thinking-slider-rail" aria-hidden="true">
                                <span className="thinking-slider-fill-mask">
                                  <span
                                    className={`thinking-slider-fill${
                                      currentThinkingFillHidden
                                        ? ' thinking-slider-fill-hidden'
                                        : ''
                                    }`}
                                    style={{
                                      clipPath: `inset(0 calc(${
                                        100 - currentThinkingOptionProgress
                                      }% + ${
                                        currentThinkingOptionProgress * 0.2 - 10
                                      }px) 0 0)`,
                                    }}
                                    onTransitionEnd={(event) => {
                                      if (
                                        event.propertyName === 'clip-path'
                                        && currentThinkingOptionIndex === 0
                                        && thinkingFillReturningToOffKey === currentThinkingCapabilityKey
                                      ) {
                                        setThinkingFillReturningToOffKey(null);
                                      }
                                    }}
                                  />
                                </span>
                                <span className="thinking-slider-ticks">
                                  {currentThinkingControl.options.map((option, index) => (
                                    <span
                                      className={`thinking-slider-tick${
                                        index <= currentThinkingOptionIndex
                                          ? ' thinking-slider-tick-active'
                                          : ''
                                      }${
                                        index === currentThinkingOptionIndex
                                          ? ' thinking-slider-tick-selected'
                                          : ''
                                      }`}
                                      key={option.value}
                                      style={{
                                        left: `${(index / (currentThinkingControl.options.length - 1)) * 100}%`,
                                      }}
                                    />
                                  ))}
                                </span>
                              </div>
                              <input
                                className="thinking-slider"
                                type="range"
                                min={0}
                                max={currentThinkingControl.options.length - 1}
                                step={1}
                                value={currentThinkingOptionIndex}
                                onChange={(event) => {
                                  const option = currentThinkingControl.options[Number(event.target.value)];
                                  if (option) {
                                    updateThinkingLevel(
                                      settings.llmProvider,
                                      currentThinkingModel,
                                      option.value,
                                    );
                                  }
                                }}
                                aria-label="思考强度"
                                aria-valuetext={
                                  currentThinkingControl.options[currentThinkingOptionIndex]?.label
                                }
                                disabled={loading}
                              />
                              <span
                                className="thinking-slider-thumb"
                                style={{
                                  translate: `calc(-50% + ${currentThinkingOptionProgress}cqw - ${
                                    currentThinkingOptionProgress * 0.2
                                  }px) -50%`,
                                }}
                                aria-hidden="true"
                              />
                            </div>
                            <div className="thinking-slider-labels" aria-hidden="true">
                              {currentThinkingControl.options.map((option, index) => (
                                <span
                                  className={`thinking-slider-label${
                                    index === currentThinkingOptionIndex
                                      ? ' thinking-slider-label-active'
                                      : ''
                                  }`}
                                  key={option.value}
                                  style={{
                                    left: `${(index / (currentThinkingControl.options.length - 1)) * 100}%`,
                                  }}
                                >
                                  {option.label}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}
                    {!usesOpenAiOAuth ? (
                      <ApiKeyField
                        key={`api-key-${settings.llmProvider}-${currentProfile.authMode}`}
                        value={currentProfile.apiKey}
                        onChange={(value) =>
                          updateActiveLlmProfile({ apiKey: value }, { showSaveStatus: true })
                        }
                        disabled={loading}
                        placeholder="sk-..."
                      />
                    ) : null}
                  </>
                )}
              </section>
            ) : null}

            <div className="debug-footer">
              <div className="debug-compact">
                <button
                  className={`debug-toggle${settings.debugOptionsExpanded ? ' debug-toggle-open' : ''}`}
                  onClick={() => updateField('debugOptionsExpanded', !settings.debugOptionsExpanded)}
                  type="button"
                >
                  <IconDebug />
                  调试选项
                  <svg className="debug-chevron" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 1L5 5L9 1" />
                  </svg>
                </button>
                {settings.debugOptionsExpanded && (
                  <div className="debug-row">
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={settings.showElapsedTime}
                        onChange={(event) => updateElapsedTime(event.target.checked)}
                        disabled={loading}
                      />
                      <span className="checkbox-label">显示耗时</span>
                    </label>
                    <label className={`checkbox-row${stageTimingDetailsDisabled ? ' checkbox-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={!stageTimingDetailsLocked && settings.showStageTimingDetails}
                        onChange={(event) => updateField('showStageTimingDetails', event.target.checked)}
                        disabled={stageTimingDetailsDisabled}
                      />
                      <span className="checkbox-label">阶段明细</span>
                    </label>
                    <label className={`checkbox-row${localDebugOptionsDisabled ? ' checkbox-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={!localDebugOptionsLocked && settings.showTypesetDebug}
                        onChange={(event) => updateField('showTypesetDebug', event.target.checked)}
                        disabled={localDebugOptionsDisabled}
                      />
                      <span className="checkbox-label">排版调试</span>
                    </label>
                    <label className={`checkbox-row${localDebugOptionsDisabled ? ' checkbox-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={!localDebugOptionsLocked && settings.showEraseDebug}
                        onChange={(event) => updateField('showEraseDebug', event.target.checked)}
                        disabled={localDebugOptionsDisabled}
                      />
                      <span className="checkbox-label">去字调试</span>
                    </label>
                    <label className={`checkbox-row${loading ? ' checkbox-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={settings.enableDebugLog}
                        onChange={(event) => updateField('enableDebugLog', event.target.checked)}
                        disabled={loading}
                      />
                      <span className="checkbox-label">日志记录</span>
                    </label>
                    <label className={`checkbox-row${localDebugOptionsDisabled ? ' checkbox-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={!localDebugOptionsLocked && settings.disableOcrPostFilter}
                        onChange={(event) => updateField('disableOcrPostFilter', event.target.checked)}
                        disabled={localDebugOptionsDisabled}
                      />
                      <span className="checkbox-label">关后处理</span>
                    </label>
                  </div>
                )}
                {settings.debugOptionsExpanded && settings.enableDebugLog && (
                  <div className="debug-actions">
                    <button
                      className="debug-download-button"
                      type="button"
                      onClick={() => void downloadDiagnosticLog()}
                      disabled={loading}
                    >
                      <IconDownload />
                      下载日志
                    </button>
                    <button
                      className="debug-download-button"
                      type="button"
                      onClick={() => void clearDiagnosticLog()}
                      disabled={loading}
                    >
                      <IconTrash />
                      清空日志
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
