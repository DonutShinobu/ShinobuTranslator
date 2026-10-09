import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
} from 'react';
import { ChevronDown } from 'lucide-react';
import {
  defaultExtensionSettings,
  geminiAppModelOptions,
  geminiApiModelOptions,
  llmBuiltInProviderDefinitions,
  llmProviderOptions,
  optimizedGeminiAppPromptTemplate,
  usesGeminiApiImagePipeline,
  usesGeminiAppImagePipeline,
  usesNanoBananaImagePipeline,
  type LlmAuthMode,
  type LlmProvider,
} from '../shared/config';
import { getExtensionRuntime } from '../shared/extensionRuntime';
import {
  getLlmThinkingControl,
  llmThinkingCapabilityKey,
  resolveLlmThinkingLevel,
  type LlmThinkingLevel,
} from '@shinobu/text-translation';
import { downloadText } from '../shared/utils';
import {
  clearDiagnosticLog as clearStoredDiagnosticLog,
  exportDiagnosticLog,
} from '../shared/diagnosticLogClient';
import {
  resolveProviderAuthorizationTarget,
  toExtensionSettingsProjection,
  type ExtensionControlProjection,
  type ExtensionSettingsProjection,
  type ProviderAuthorizationAction,
  type ProviderAuthorizationProjection,
  type ProviderAuthorizationTarget,
  type PublicLlmProviderProfile,
} from '../shared/extensionControl';
import {
  createExtensionControlClient,
  isExtensionSettingsConflict,
  rebaseExtensionSettingsProjection,
  type ExtensionControlClient,
} from './extensionControlClient';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './components/ui/accordion';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import { Input } from './components/ui/input';
import { Kbd } from './components/ui/kbd';
import { Label } from './components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { Separator } from './components/ui/separator';
import { Slider } from './components/ui/slider';
import { Switch } from './components/ui/switch';
import { Textarea } from './components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';

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

function ControlHint({ content, children }: { content: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent sideOffset={4} collisionPadding={8}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
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
      <Label className="field-label" htmlFor={inputId}>
        API Key
      </Label>
      <div className="api-key-control">
        <Input
          id={inputId}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={placeholder}
        />
        <ControlHint content={toggleLabel}>
          <Button
            variant="outline"
            className="api-key-visibility-button"
            type="button"
            onClick={() => setRevealed((current) => !current)}
            disabled={disabled}
            aria-label={toggleLabel}
            aria-controls={inputId}
            aria-pressed={revealed}
          >
            {revealed ? <IconEye /> : <IconEyeOff />}
          </Button>
        </ControlHint>
      </div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  return (
    <ToggleGroup
      type="single"
      className={`seg-control${disabled ? ' seg-disabled' : ''}`}
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue) onChange(nextValue as T);
      }}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      <span
        className="seg-pill"
        aria-hidden="true"
        style={{
          width: `calc(${100 / options.length}% - ${6 / options.length}px)`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {options.map((option) => (
        <ToggleGroupItem className="seg-option" key={option.value} value={option.value}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

type SelectOption<T extends string> = {
  value: T;
  label: string;
};

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
  return (
    <div className="select-root">
      <Select
        value={value}
        onValueChange={(nextValue) => onChange(nextValue as T)}
        disabled={disabled}
      >
        <SelectTrigger className="select-trigger" aria-label={ariaLabel}>
          <SelectValue className="select-value" />
        </SelectTrigger>
        <SelectContent className="select-menu" position="popper" align="start" collisionPadding={8}>
          {options.map((option) => (
            <SelectItem className="select-option" key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<ExtensionSettingsProjection>(
    toExtensionSettingsProjection(defaultExtensionSettings),
  );
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle', message: '' });
  const [shortcutsLoading, setShortcutsLoading] = useState(true);
  const [shortcuts, setShortcuts] = useState<ShortcutState>(defaultShortcutState);
  const [shortcutError, setShortcutError] = useState('');
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
    authenticated: false,
    pending: false,
    error: '',
  });
  const hasHydratedRef = useRef(false);
  const committedSettingsRef = useRef<ExtensionSettingsProjection>(
    toExtensionSettingsProjection(defaultExtensionSettings),
  );
  const settingsDirtyRef = useRef(false);
  const skipNextSettingsPersistenceRef = useRef(false);
  const nextSaveShowsStatusRef = useRef(false);
  const saveRequestIdRef = useRef(0);
  const controlClientRef = useRef<ExtensionControlClient | null>(null);
  const [apiKeyValues, setApiKeyValues] = useState<Partial<Record<LlmProvider, string>>>({});
  const [apiKeyEditVersion, setApiKeyEditVersion] = useState(0);
  const apiKeyValuesRef = useRef<Partial<Record<LlmProvider, string>>>({});
  const apiKeyDirtyRef = useRef<Partial<Record<LlmProvider, boolean>>>({});

  function getControlClient(): ExtensionControlClient {
    controlClientRef.current ??= createExtensionControlClient();
    return controlClientRef.current;
  }

  function applyAuthorizationProjection(
    projection: ProviderAuthorizationProjection,
  ): OpenAiOAuthViewState {
    return {
      loading: false,
      busy: false,
      authenticated: projection.state === 'ready',
      pending: projection.state === 'authorizing',
      email: projection.identity?.email,
      planType: projection.identity?.planType,
      error: projection.error ?? '',
    };
  }

  function applyAccessProjection(projection: ExtensionControlProjection): void {
    setOpenAiStatus(applyAuthorizationProjection(projection.access.openAiOAuth));
    setGeminiAppStatus(applyAuthorizationProjection(projection.access.geminiApp));
  }

  useEffect(() => {
    const control = getControlClient();
    const unsubscribe = control.subscribe((projection) => {
      applyAccessProjection(projection);
      if (!settingsDirtyRef.current) {
        control.adoptProjection(projection);
        committedSettingsRef.current = projection.settings;
        if (hasHydratedRef.current) {
          skipNextSettingsPersistenceRef.current = true;
        }
        setSettings(projection.settings);
      }
    });
    async function loadControlProjection(): Promise<void> {
      try {
        const projection = await control.read();
        settingsDirtyRef.current = false;
        skipNextSettingsPersistenceRef.current = false;
        committedSettingsRef.current = projection.settings;
        setSettings(projection.settings);
        applyAccessProjection(projection);
      } catch (error) {
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setLoading(false);
      }
    }
    void loadControlProjection();
    return unsubscribe;
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
    settingsDirtyRef.current = true;
    nextSaveShowsStatusRef.current = nextSaveShowsStatusRef.current || options.showSaveStatus === true;
  }

  function applyNanoBananaDebugLocks(
    next: ExtensionSettingsProjection,
  ): ExtensionSettingsProjection {
    if (!usesNanoBananaImagePipeline(next)) return next;
    return {
      ...next,
      showStageTimingDetails: false,
      showTypesetDebug: false,
      showEraseDebug: false,
      disableOcrPostFilter: false,
    };
  }

  function updateField<K extends keyof ExtensionSettingsProjection>(
    key: K,
    value: ExtensionSettingsProjection[K],
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

  function updateActiveLlmProfile(
    patch: Partial<PublicLlmProviderProfile>,
    options?: SettingsUpdateOptions,
  ): void {
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

  function updateActiveApiKey(value: string): void {
    const provider = settings.llmProvider;
    apiKeyDirtyRef.current[provider] = true;
    apiKeyValuesRef.current = {
      ...apiKeyValuesRef.current,
      [provider]: value,
    };
    setStatus({ kind: 'saving', message: '正在自动保存...' });
    setApiKeyValues((current) => ({
      ...current,
      [provider]: value,
    }));
    setApiKeyEditVersion((version) => version + 1);
  }

  function updateTranslator(translator: ExtensionSettingsProjection['translator']): void {
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

  async function runProviderAccessAction(
    target: ProviderAuthorizationTarget,
    action: ProviderAuthorizationAction,
    setViewState: Dispatch<SetStateAction<OpenAiOAuthViewState>>,
    busyField: 'loading' | 'busy',
    onSuccess?: (projection: ExtensionControlProjection) => void,
  ): Promise<void> {
    setViewState((previous) => ({
      ...previous,
      [busyField]: true,
      error: '',
    }));
    try {
      const projection = await getControlClient().performAccess(target, action);
      applyAccessProjection(projection);
      onSuccess?.(projection);
    } catch (error) {
      setViewState((previous) => ({
        ...previous,
        loading: false,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  function refreshOpenAiOAuthStatus(): Promise<void> {
    return runProviderAccessAction('openai-oauth', 'refresh', setOpenAiStatus, 'loading');
  }

  function loginOpenAiOAuth(): Promise<void> {
    return runProviderAccessAction(
      'openai-oauth',
      'login',
      setOpenAiStatus,
      'busy',
      (projection) => setStatus({
        kind: 'success',
        message: projection.access.openAiOAuth.state === 'ready'
          ? 'OpenAI 已登录'
          : 'OpenAI 登录页已打开，请在新标签页完成授权',
      }),
    );
  }

  function logoutOpenAiOAuth(): Promise<void> {
    return runProviderAccessAction(
      'openai-oauth',
      'logout',
      setOpenAiStatus,
      'busy',
      () => setStatus({ kind: 'success', message: 'OpenAI 已退出登录' }),
    );
  }

  function refreshGeminiAppAuthStatus(): Promise<void> {
    return runProviderAccessAction('gemini-app', 'refresh', setGeminiAppStatus, 'loading');
  }

  function loginGeminiApp(): Promise<void> {
    return runProviderAccessAction(
      'gemini-app',
      'login',
      setGeminiAppStatus,
      'busy',
      (projection) => setStatus({
        kind: 'success',
        message: projection.access.geminiApp.state === 'ready'
          ? '登录状态已更新'
          : 'Gemini 登录页已打开，请在新标签页完成登录',
      }),
    );
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
  const currentThinkingOptionIndex = currentThinkingControl?.kind === 'slider'
    ? Math.max(
        0,
        currentThinkingControl.options.findIndex((option) => option.value === currentThinkingLevel),
      )
    : 0;
  const activeAuthorizationTarget = resolveProviderAuthorizationTarget(settings);
  const usesOpenAiOAuth = activeAuthorizationTarget === 'openai-oauth';
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

  async function persistSettings(
    nextSettings: ExtensionSettingsProjection,
    options: PersistSettingsOptions = {},
  ): Promise<void> {
    const requestId = saveRequestIdRef.current + 1;
    saveRequestIdRef.current = requestId;
    if (options.silent) {
      setStatus((prev) => (prev.kind === 'saving' || prev.kind === 'success' ? { kind: 'idle', message: '' } : prev));
    } else {
      setStatus({ kind: 'saving', message: '正在自动保存...' });
    }
    try {
      const projection = await getControlClient().replaceSettings(nextSettings);
      applyAccessProjection(projection);
      committedSettingsRef.current = projection.settings;
      if (saveRequestIdRef.current === requestId) {
        settingsDirtyRef.current = false;
        skipNextSettingsPersistenceRef.current = true;
        setSettings(projection.settings);
        if (!options.silent) {
          setStatus({ kind: 'success', message: '已自动保存' });
        }
      }
    } catch (error) {
      if (
        saveRequestIdRef.current === requestId
        && isExtensionSettingsConflict(error)
      ) {
        try {
          const latest = await getControlClient().read();
          const rebased = rebaseExtensionSettingsProjection(
            committedSettingsRef.current,
            nextSettings,
            latest.settings,
          );
          committedSettingsRef.current = latest.settings;
          applyAccessProjection(latest);
          settingsDirtyRef.current = true;
          nextSaveShowsStatusRef.current = true;
          setStatus({ kind: 'saving', message: '检测到并发修改，正在合并并重试...' });
          setSettings(rebased);
          return;
        } catch (refreshError) {
          error = refreshError;
        }
      }
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
      const log = await exportDiagnosticLog();
      if (log.eventCount === 0) {
        setStatus({ kind: 'error', message: '暂无可下载日志，请先开启日志记录并执行一次翻译' });
        return;
      }
      downloadText(log.text, log.filenamePrefix);
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
      await clearStoredDiagnosticLog();
      setStatus({ kind: 'success', message: '日志已清空' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  useEffect(() => {
    if (loading || !activeAuthorizationTarget) return;
    if (activeAuthorizationTarget === 'openai-oauth') {
      void refreshOpenAiOAuthStatus();
      return;
    }
    void refreshGeminiAppAuthStatus();
  }, [loading, activeAuthorizationTarget]);

  useEffect(() => {
    if (loading || currentProfile.authMode !== 'api_key') return;
    const provider = settings.llmProvider;
    let active = true;
    void getControlClient().revealApiKey(provider)
      .then((apiKey) => {
        if (!active || apiKeyDirtyRef.current[provider]) return;
        apiKeyValuesRef.current = {
          ...apiKeyValuesRef.current,
          [provider]: apiKey,
        };
        setApiKeyValues((current) => ({ ...current, [provider]: apiKey }));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      active = false;
    };
  }, [loading, settings.llmProvider, currentProfile.authMode]);

  useEffect(() => {
    if (loading) {
      return;
    }
    if (!hasHydratedRef.current) {
      hasHydratedRef.current = true;
      return;
    }
    if (skipNextSettingsPersistenceRef.current) {
      skipNextSettingsPersistenceRef.current = false;
      return;
    }

    const showSaveStatus = nextSaveShowsStatusRef.current;
    nextSaveShowsStatusRef.current = false;
    void persistSettings(settings, { silent: !showSaveStatus });
  }, [loading, settings]);

  useEffect(() => {
    const timeoutIds = llmProviderOptions.flatMap(({ value: provider }) => {
      const apiKey = apiKeyValuesRef.current[provider];
      if (!apiKeyDirtyRef.current[provider] || apiKey === undefined) return [];
      return [window.setTimeout(() => {
        const operation = apiKey.trim().length > 0
          ? getControlClient().replaceApiKey(provider, apiKey)
          : getControlClient().clearApiKey(provider);
        void operation
          .then((projection) => {
            applyAccessProjection(projection);
            if (apiKeyValuesRef.current[provider] === apiKey) {
              apiKeyDirtyRef.current[provider] = false;
              const hasPendingSave = Object.values(apiKeyDirtyRef.current).some(Boolean);
              if (!hasPendingSave) {
                setStatus({
                  kind: 'success',
                  message: '已自动保存',
                });
              }
            }
          })
          .catch((error: unknown) => {
            setStatus({
              kind: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          });
      }, 500)];
    });
    return () => {
      for (const timeoutId of timeoutIds) window.clearTimeout(timeoutId);
    };
  }, [apiKeyEditVersion]);

  return (
    <TooltipProvider>
      <main className="popup">
        {status.message ? (
          <div className="status-bubble-position">
            <Badge
              variant="outline"
              className={`status-bubble status-${status.kind} animate-in fade-in-0 slide-in-from-top-2 duration-200`}
              role={status.kind === 'error' ? 'alert' : 'status'}
            >
              {status.message}
            </Badge>
          </div>
        ) : null}
        <header className="popup-header">
          <div className="popup-header-brand">
            <img className="popup-header-logo" src="icons/icon128.png" alt="" aria-hidden="true" />
            <div className="popup-header-text">
              <h1>
                <img
                  className="popup-header-wordmark"
                  src="brand/shinobu-wordmark.svg"
                  alt="ShinobuTranslator"
                />
              </h1>
              <p className="subtitle">漫画图片翻译助手</p>
            </div>
          </div>
          <div className="popup-header-meta">
            <Button asChild variant="ghost" className="popup-header-github">
              <a
                href="https://github.com/DonutShinobu/ShinobuTranslator"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
              >
                <IconGitHub />
              </a>
            </Button>
            {extensionVersion ? (
              <span className="popup-header-version">v{extensionVersion}</span>
            ) : null}
          </div>
        </header>

        <div className="popup-body">
          {loading ? (
            <p className="loading-text">正在读取配置…</p>
          ) : (
            <>
              <section className="panel">
                <Separator className="panel-separator" />
                <div className="panel-title panel-title-with-shortcuts">
                  <span className="panel-title-copy">
                    <IconTranslate />
                    翻译设置
                  </span>
                  <ControlHint content={shortcutError || '打开扩展命令管理页'}>
                    <Button
                      variant="ghost"
                      className={`panel-title-shortcuts${shortcutError ? ' panel-title-shortcuts-error' : ''}`}
                      type="button"
                      onClick={openShortcutManager}
                      aria-label="管理扩展命令"
                    >
                      {shortcutCommandDefinitions.map((definition) => {
                        const shortcut = shortcuts[definition.name];
                        return (
                          <span className="panel-title-shortcut-row" key={definition.name}>
                            <span className="panel-title-shortcut-label">{definition.label}</span>
                            <Kbd
                              className={`panel-title-shortcut-key${!shortcutsLoading && !shortcut ? ' panel-title-shortcut-key-unbound' : ''}`}
                            >
                              {shortcutsLoading ? '读取中' : shortcut || '未绑定'}
                            </Kbd>
                          </span>
                        );
                      })}
                    </Button>
                  </ControlHint>
                </div>
                <div className="settings-stack">
                  <div className="setting-row">
                    <Label className="field-label">服务</Label>
                    <SegmentedControl
                      ariaLabel="服务"
                      options={[
                        { value: 'google_web', label: '谷歌翻译' },
                        { value: 'llm', label: '大模型' },
                      ]}
                      value={settings.translator}
                      onChange={(value) =>
                        updateTranslator(value as ExtensionSettingsProjection['translator'])
                      }
                      disabled={loading}
                    />
                  </div>
                  <div className="setting-row">
                    <Label className="field-label">语言</Label>
                    <SegmentedControl
                      ariaLabel="语言"
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
                  <Separator className="panel-separator" />
                  <div className="panel-title">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          className="mode-options-trigger"
                          type="button"
                          aria-label="模式选项"
                          disabled={loading}
                        >
                          <IconMode />
                          模式
                          <span className="mode-options-affordance" aria-hidden="true">
                            <ChevronDown className="mode-options-chevron" />
                          </span>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="mode-options-menu"
                        aria-label="模式选项"
                        align="start"
                        collisionPadding={8}
                      >
                        <div className="mode-options-switch-row">
                          <Switch
                            id="enable-image-editing"
                            checked={settings.enableImageEditing}
                            onCheckedChange={(checked) => updateField('enableImageEditing', checked)}
                            disabled={loading}
                          />
                          <Label htmlFor="enable-image-editing">直接编辑图片</Label>
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <SegmentedControl
                    ariaLabel="模式"
                    options={[
                      { value: 'translate', label: '翻译' },
                      { value: 'original', label: '原文' },
                      { value: 'erase', label: '去字' },
                    ]}
                    value={settings.processMode}
                    onChange={(v) =>
                      updateField('processMode', v as ExtensionSettingsProjection['processMode'])
                    }
                    disabled={loading}
                  />
                </section>
              ) : null}

              {settings.translator === 'llm' ? (
                <section className="panel panel-llm animate-in fade-in-0 slide-in-from-top-2 duration-200">
                  <Separator className="panel-separator" />
                  <div className="panel-title">
                    <IconLLM />
                    大模型配置
                  </div>
                  <div className="field">
                    <Label className="field-label">LLM 提供商</Label>
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
                        <Label className="field-label">认证方式</Label>
                        <SegmentedControl<LlmAuthMode>
                          ariaLabel="认证方式"
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
                        <Label className="field-label">模型</Label>
                        {usesGeminiApi ? (
                          <SelectControl
                            ariaLabel="模型"
                            options={geminiApiModelOptions}
                            value={settings.geminiAppModel}
                            onChange={(value) => updateField('geminiAppModel', value)}
                            disabled={loading}
                          />
                        ) : (
                          <SegmentedControl<ExtensionSettingsProjection['geminiAppModel']>
                            ariaLabel="模型"
                            options={geminiAppModelOptions}
                            value={settings.geminiAppModel}
                            onChange={(value) => updateField('geminiAppModel', value)}
                            disabled={loading}
                          />
                        )}
                      </div>
                      {usesGeminiApp ? (
                        <>
                          <div className="auth-status-row">
                            <Label className="field-label">登录状态</Label>
                            <div className="auth-status-control">
                              <div className="oauth-copy">
                                <span
                                  className={`oauth-dot${geminiAppStatus.authenticated ? ' oauth-dot-authed' : ''}`}
                                />
                                <div className="oauth-title">{geminiStatusLabel}</div>
                              </div>
                              <Button
                                variant="ghost"
                                className="oauth-action"
                                type="button"
                                onClick={() => {
                                  void (geminiAppStatus.authenticated || geminiAppStatus.pending
                                    ? refreshGeminiAppAuthStatus()
                                    : loginGeminiApp());
                                }}
                                disabled={
                                  loading || geminiAppStatus.loading || geminiAppStatus.busy
                                }
                              >
                                {geminiAppStatus.busy
                                  ? '处理中...'
                                  : geminiAppStatus.authenticated || geminiAppStatus.pending
                                    ? '检查状态'
                                    : '登录 Gemini'}
                              </Button>
                            </div>
                          </div>
                        </>
                      ) : null}
                      {usesGeminiApi ? (
                        <ApiKeyField
                          key={`api-key-${settings.llmProvider}-${currentProfile.authMode}`}
                          value={apiKeyValues[settings.llmProvider] ?? ''}
                          onChange={updateActiveApiKey}
                          disabled={loading || apiKeyValues[settings.llmProvider] === undefined}
                          placeholder="AIza..."
                        />
                      ) : null}
                      <div className="field">
                        <div className="field-label field-label-action">
                          <Label htmlFor="gemini-prompt-template">提示词</Label>
                          <ControlHint content="重置提示词">
                            <Button
                              variant="ghost"
                              className="field-label-icon-button"
                              type="button"
                              onClick={resetGeminiAppPromptTemplate}
                              disabled={loading}
                              aria-label="重置提示词"
                            >
                              <IconRefresh />
                            </Button>
                          </ControlHint>
                        </div>
                        <Textarea
                          id="gemini-prompt-template"
                          value={settings.geminiAppPromptTemplate}
                          onChange={(event) =>
                            updateField('geminiAppPromptTemplate', event.target.value, {
                              showSaveStatus: true,
                            })
                          }
                          disabled={loading}
                          rows={5}
                        />
                      </div>
                    </>
                  ) : settings.llmProvider === 'custom' ? (
                    <>
                      <Label className="field">
                        <span className="field-label">Base URL</span>
                        <Input
                          type="text"
                          value={currentProfile.customBaseUrl}
                          onChange={(event) =>
                            updateActiveLlmProfile(
                              { customBaseUrl: event.target.value },
                              { showSaveStatus: true },
                            )
                          }
                          disabled={loading}
                          placeholder="https://api.example.com/v1"
                        />
                      </Label>
                      <Label className="field">
                        <span className="field-label">模型名称</span>
                        <Input
                          type="text"
                          value={currentProfile.modelCustom}
                          onChange={(event) =>
                            updateActiveLlmProfile(
                              { modelCustom: event.target.value },
                              { showSaveStatus: true },
                            )
                          }
                          disabled={loading}
                          placeholder="例如：your-model-name"
                        />
                      </Label>
                      <ApiKeyField
                        key={`api-key-${settings.llmProvider}-${currentProfile.authMode}`}
                        value={apiKeyValues[settings.llmProvider] ?? ''}
                        onChange={updateActiveApiKey}
                        disabled={loading || apiKeyValues[settings.llmProvider] === undefined}
                        placeholder="sk-..."
                      />
                    </>
                  ) : (
                    <>
                      {settings.llmProvider === 'openai' ? (
                        <div className="auth-mode-field">
                          <Label className="field-label">认证方式</Label>
                          <SegmentedControl<LlmAuthMode>
                            ariaLabel="认证方式"
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
                          <Label className="field-label">登录状态</Label>
                          <div className="auth-status-control">
                            <div className="oauth-copy">
                              <span
                                className={`oauth-dot${openAiStatus.authenticated ? ' oauth-dot-authed' : ''}`}
                              />
                              <div className="oauth-title">{openAiStatusLabel}</div>
                            </div>
                            <Button
                              variant="ghost"
                              className="oauth-action"
                              type="button"
                              onClick={() => {
                                void (openAiStatus.authenticated
                                  ? logoutOpenAiOAuth()
                                  : openAiStatus.pending
                                    ? refreshOpenAiOAuthStatus()
                                    : loginOpenAiOAuth());
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
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      <div className="field model-field">
                        <span className="field-label">模型名称</span>
                        <div className="model-control">
                          {currentProfile.useCustomModel ? (
                            <Input
                              aria-label="模型名称"
                              type="text"
                              value={currentProfile.modelCustom}
                              onChange={(event) =>
                                updateActiveLlmProfile(
                                  { modelCustom: event.target.value },
                                  { showSaveStatus: true },
                                )
                              }
                              disabled={loading}
                              placeholder={builtInCustomModelPlaceholder}
                            />
                          ) : (
                            <SelectControl
                              ariaLabel="模型名称"
                              options={currentProviderModels.map((model) => ({
                                value: model,
                                label: model,
                              }))}
                              value={currentProfile.modelPreset}
                              onChange={(modelPreset) => updateActiveLlmProfile({ modelPreset })}
                              disabled={loading}
                            />
                          )}
                          <Label
                            className={`custom-model-toggle${loading ? ' custom-model-toggle-disabled' : ''}`}
                          >
                            <Checkbox
                              aria-label="自定义模型"
                              checked={currentProfile.useCustomModel}
                              onCheckedChange={(checked) => updateUseCustomModel(checked === true)}
                              disabled={loading}
                            />
                            <span>自定义</span>
                          </Label>
                        </div>
                      </div>
                      {currentThinkingModel && currentThinkingControl && currentThinkingLevel ? (
                        <div className="field thinking-field">
                          <Label className="field-label">思考强度</Label>
                          {currentThinkingControl.kind === 'fixed' ? (
                            <span className="thinking-fixed-notice">
                              {currentThinkingControl.notice}
                            </span>
                          ) : currentThinkingControl.kind === 'toggle' ? (
                            <SegmentedControl<LlmThinkingLevel>
                              ariaLabel="思考强度"
                              options={currentThinkingControl.options}
                              value={currentThinkingLevel}
                              onChange={(level) =>
                                updateThinkingLevel(
                                  settings.llmProvider,
                                  currentThinkingModel,
                                  level,
                                )
                              }
                              disabled={loading}
                            />
                          ) : (
                            <div className="thinking-slider-control">
                              <Slider
                                className="thinking-slider"
                                style={{
                                  '--thinking-slider-progress':
                                    currentThinkingOptionIndex / (currentThinkingControl.options.length - 1),
                                } as CSSProperties}
                                min={0}
                                max={currentThinkingControl.options.length - 1}
                                step={1}
                                value={[currentThinkingOptionIndex]}
                                onValueChange={([index]) => {
                                  const option = currentThinkingControl.options[index];
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
                              >
                                <span className="thinking-slider-ticks" aria-hidden="true">
                                  {currentThinkingControl.options.map((option, index) => (
                                    <span
                                      className={`thinking-slider-tick${index <= currentThinkingOptionIndex ? ' thinking-slider-tick-active' : ''}${index === currentThinkingOptionIndex ? ' thinking-slider-tick-selected' : ''}`}
                                      key={option.value}
                                      style={{
                                        left: `${(index / (currentThinkingControl.options.length - 1)) * 100}%`,
                                      }}
                                    />
                                  ))}
                                </span>
                              </Slider>
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
                          value={apiKeyValues[settings.llmProvider] ?? ''}
                          onChange={updateActiveApiKey}
                          disabled={loading || apiKeyValues[settings.llmProvider] === undefined}
                          placeholder="sk-..."
                        />
                      ) : null}
                    </>
                  )}
                </section>
              ) : null}

              <div className="debug-footer">
                <Separator className="panel-separator" />
                <Accordion
                  className="debug-compact"
                  type="single"
                  collapsible
                  value={settings.debugOptionsExpanded ? 'debug' : ''}
                  onValueChange={(value) => updateField('debugOptionsExpanded', value === 'debug')}
                >
                  <AccordionItem className="debug-item" value="debug">
                    <AccordionTrigger className="debug-toggle">
                      <span className="debug-toggle-label">
                        <IconDebug />
                        调试选项
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="debug-content">
                      <div className="debug-row">
                        <Label className="checkbox-row">
                          <Checkbox
                            aria-label="显示耗时"
                            checked={settings.showElapsedTime}
                            onCheckedChange={(checked) => updateElapsedTime(checked === true)}
                            disabled={loading}
                          />
                          <span className="checkbox-label">显示耗时</span>
                        </Label>
                        <Label
                          className={`checkbox-row${stageTimingDetailsDisabled ? ' checkbox-disabled' : ''}`}
                        >
                          <Checkbox
                            aria-label="阶段明细"
                            checked={!stageTimingDetailsLocked && settings.showStageTimingDetails}
                            onCheckedChange={(checked) =>
                              updateField('showStageTimingDetails', checked === true)
                            }
                            disabled={stageTimingDetailsDisabled}
                          />
                          <span className="checkbox-label">阶段明细</span>
                        </Label>
                        <Label
                          className={`checkbox-row${localDebugOptionsDisabled ? ' checkbox-disabled' : ''}`}
                        >
                          <Checkbox
                            aria-label="排版调试"
                            checked={!localDebugOptionsLocked && settings.showTypesetDebug}
                            onCheckedChange={(checked) =>
                              updateField('showTypesetDebug', checked === true)
                            }
                            disabled={localDebugOptionsDisabled}
                          />
                          <span className="checkbox-label">排版调试</span>
                        </Label>
                        <Label
                          className={`checkbox-row${localDebugOptionsDisabled ? ' checkbox-disabled' : ''}`}
                        >
                          <Checkbox
                            aria-label="去字调试"
                            checked={!localDebugOptionsLocked && settings.showEraseDebug}
                            onCheckedChange={(checked) =>
                              updateField('showEraseDebug', checked === true)
                            }
                            disabled={localDebugOptionsDisabled}
                          />
                          <span className="checkbox-label">去字调试</span>
                        </Label>
                        <Label className={`checkbox-row${loading ? ' checkbox-disabled' : ''}`}>
                          <Checkbox
                            aria-label="日志记录"
                            checked={settings.enableDebugLog}
                            onCheckedChange={(checked) =>
                              updateField('enableDebugLog', checked === true)
                            }
                            disabled={loading}
                          />
                          <span className="checkbox-label">日志记录</span>
                        </Label>
                        <Label
                          className={`checkbox-row${localDebugOptionsDisabled ? ' checkbox-disabled' : ''}`}
                        >
                          <Checkbox
                            aria-label="关后处理"
                            checked={!localDebugOptionsLocked && settings.disableOcrPostFilter}
                            onCheckedChange={(checked) =>
                              updateField('disableOcrPostFilter', checked === true)
                            }
                            disabled={localDebugOptionsDisabled}
                          />
                          <span className="checkbox-label">关后处理</span>
                        </Label>
                      </div>
                      {settings.enableDebugLog && (
                        <div className="debug-actions animate-in fade-in-0 duration-200">
                          <Button
                            variant="outline"
                            className="debug-download-button"
                            type="button"
                            onClick={() => void downloadDiagnosticLog()}
                            disabled={loading}
                          >
                            <IconDownload />
                            下载日志
                          </Button>
                          <Button
                            variant="outline"
                            className="debug-download-button"
                            type="button"
                            onClick={() => void clearDiagnosticLog()}
                            disabled={loading}
                          >
                            <IconTrash />
                            清空日志
                          </Button>
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            </>
          )}
        </div>
      </main>
    </TooltipProvider>
  );
}
