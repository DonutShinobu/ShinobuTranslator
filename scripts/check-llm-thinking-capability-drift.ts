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
  deepseek: 'deepseek',
  glm: 'zai',
  kimi: 'moonshotai',
  minimax: 'minimax',
  mimo: 'xiaomi',
  openai: 'openai',
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
  if (localProvider === 'deepseek') {
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
    if (model === 'kimi-k3') {
      // Known models.dev discrepancy: official Moonshot docs say K3 is fixed Max.
      // Keep this snapshot of the upstream claim so a future correction/change triggers review.
      return normalizeRemoteOptions([
        { type: 'toggle' },
        { type: 'effort', values: ['low', 'high', 'max'] },
      ]);
    }
    return [{ type: 'toggle' }];
  }
  if (localProvider === 'minimax') {
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
    const remoteModel = remoteProvider ? remote[remoteProvider]?.models?.[model] : undefined;
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
