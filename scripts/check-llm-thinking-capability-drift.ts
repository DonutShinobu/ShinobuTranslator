import {
  llmThinkingCapabilityRegistry,
  type LlmThinkingCapability,
  type LlmThinkingLevel,
} from '@shinobu/text-translation';

type ModelsDevReasoningOption = {
  type: 'toggle' | 'effort';
  values?: string[];
};

type ModelsDevApi = Record<string, {
  models?: Record<string, {
    reasoning_options?: ModelsDevReasoningOption | ModelsDevReasoningOption[];
  }>;
}>;

const modelsDevProviderByLocalProvider: Record<string, string> = {
  alibaba: 'alibaba-cn',
  deepseek: 'deepseek',
  doubao: 'volcengine',
  glm: 'zai',
  kimi: 'moonshotai',
  minimax: 'minimax',
  mimo: 'xiaomi',
  openai: 'openai',
};

const officialDoubaoSource = 'https://docs.volcengine.com/docs/ark/deep-thinking?lang=en';
const officialDoubaoOptions: ModelsDevReasoningOption[] = [
  { type: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
];
// shortcut: models.dev omits these official IDs (verified 2026-10-18); remove as its catalog catches up.
const officialModelFallbacks: Record<string, ModelsDevReasoningOption[]> = {
  'doubao/doubao-seed-2-1-pro-260915': officialDoubaoOptions,
  'doubao/doubao-seed-2-1-lite-260915': officialDoubaoOptions,
};

function normalizeRemoteOptions(
  value: ModelsDevReasoningOption | ModelsDevReasoningOption[] | undefined,
): ModelsDevReasoningOption[] {
  const options = Array.isArray(value)
    ? value
    : value?.type
      ? [value]
      : [];
  return options
    .filter((option) => option.type === 'toggle' || option.type === 'effort')
    .map((option) => ({
      type: option.type,
      ...(option.values ? { values: [...option.values] } : {}),
    }))
    .sort((left, right) => left.type.localeCompare(right.type));
}

function effortValues(levels: LlmThinkingLevel[]): string[] {
  return levels.flatMap((level) => {
    if (level === 'off') return ['none'];
    if (level === 'on') return [];
    return [level];
  });
}

function expectedRemoteOptions(
  localProvider: string,
  model: string,
  capability: LlmThinkingCapability,
): ModelsDevReasoningOption[] {
  if (localProvider === 'doubao') {
    // Ark also accepts aliases: minimal disables thinking; xhigh/max map to high.
    return [{ type: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }];
  }
  if (localProvider === 'deepseek' || localProvider === 'alibaba') {
    return normalizeRemoteOptions([
      { type: 'toggle' },
      { type: 'effort', values: capability.levels.filter((level) => level !== 'off') },
    ]);
  }
  if (localProvider === 'glm') {
    return capability.levels.includes('on')
      ? [{ type: 'toggle' }]
      : [{ type: 'effort', values: capability.levels.filter((level) => level !== 'off') }];
  }
  if (localProvider === 'kimi') {
    if (model === 'kimi-k3' || model === 'kimi-k3.1-pro') {
      return [{ type: 'effort', values: capability.levels }];
    }
    return capability.levels.includes('off') ? [{ type: 'toggle' }] : [];
  }
  if (localProvider === 'minimax') {
    if (model === 'MiniMax-M3.1-Flash') {
      return [{ type: 'effort', values: capability.levels }];
    }
    return model === 'MiniMax-M3' ? [{ type: 'toggle' }] : [];
  }
  if (localProvider === 'mimo') {
    return [{ type: 'toggle' }];
  }
  if (localProvider === 'openai') {
    return [{ type: 'effort', values: effortValues(capability.levels) }];
  }
  return [];
}

async function main(): Promise<void> {
  let remote: ModelsDevApi;
  try {
    const response = await fetch('https://models.dev/api.json', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      console.warn(`models.dev 漂移检查跳过：HTTP ${response.status}`);
      return;
    }
    remote = await response.json() as ModelsDevApi;
  } catch (error) {
    console.warn(`models.dev 漂移检查跳过：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const drift: string[] = [];
  for (const [key, capability] of Object.entries(llmThinkingCapabilityRegistry)) {
    const separator = key.indexOf('/');
    const localProvider = key.slice(0, separator);
    const model = key.slice(separator + 1);
    const remoteProvider = modelsDevProviderByLocalProvider[localProvider];
    // models.dev still lists Flash under the legacy alias accepted by DeepSeek.
    let remoteModel = (remoteProvider ? remote[remoteProvider]?.models?.[model] : undefined)
      ?? (key === 'deepseek/deepseek-flash' ? remote.deepseek?.models?.['deepseek-v4-flash'] : undefined);
    if (!remoteModel && officialModelFallbacks[key]) {
      remoteModel = { reasoning_options: officialModelFallbacks[key] };
      console.warn(`models.dev 缺少 ${key}：使用已核验的火山方舟官方能力快照（2026-10-18）：${officialDoubaoSource}`);
    }
    if (!remoteModel) {
      drift.push(`${key}: models.dev 缺少对应模型`);
      continue;
    }

    const actual = normalizeRemoteOptions(remoteModel.reasoning_options);
    const expected = normalizeRemoteOptions(expectedRemoteOptions(localProvider, model, capability));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      drift.push(
        `${key}: reasoning_options 已变化\n`
        + `  基线: ${JSON.stringify(expected)}\n`
        + `  当前: ${JSON.stringify(actual)}`,
      );
    }
  }

  if (drift.length > 0) {
    console.error([
      'models.dev 的思考能力数据发生漂移。',
      '请对照官方供应商文档人工核验；不要自动覆盖 packages/text-translation/src/llmThinking.ts。',
      ...drift,
    ].join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`models.dev 思考能力基线未漂移（${Object.keys(llmThinkingCapabilityRegistry).length} 个模型）`);
}

await main();
