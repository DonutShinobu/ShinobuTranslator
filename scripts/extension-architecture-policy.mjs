import { createHash } from 'node:crypto';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import tsModule from 'typescript';

const sourceExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);
const ts = tsModule;

const compositionRoots = new Set([
  'apps/extension/src/background.ts',
  'apps/extension/src/content.ts',
  'apps/extension/src/offscreen.ts',
  'apps/extension/src/popup.tsx',
]);

const frozenExtensionMigrationEdges = new Map([
  [
    'apps/extension/src/background.ts',
    '../../../src/background/index',
  ],
  [
    'apps/extension/src/content.ts',
    '../../../src/content/index',
  ],
]);

const allowedFrozenRootImports = new Map([
  [
    'apps/extension/src/background.ts',
    new Set([
      '../../../src/background/index',
      './capabilities/chromeAdapter',
      './pipelineHost/chromeLifecycle',
    ]),
  ],
  [
    'apps/extension/src/content.ts',
    new Set([
      '../../../src/content/index',
      './capabilities/chromeAdapter',
    ]),
  ],
]);

export const frozenExtensionMigrationEdgeKeys = Object.freeze(
  [...frozenExtensionMigrationEdges].map(
    ([source, target]) => `${source} -> ${target}`,
  ),
);

export const frozenExtensionMigrationRemovalCondition = Object.freeze({
  trigger:
    'background/content reachable closure is app-owned or consumed through formal packages/* boundaries',
  action:
    'remove the corresponding import, frozen policy record, and architecture tests in the same change',
  indefiniteRetentionAllowed: false,
});

const grandfatheredLegacyExtensionRootEdgeKeys = new Set([
  'apps/extension/src/benchmark.ts -> ../../../src/benchmark/browserEntry',
  'apps/extension/src/offscreen.ts -> ../../../src/offscreen/index',
  'apps/extension/src/popup.tsx -> ../../../src/popup/main',
]);

const legacyExtensionSeams = new Set([
  'src/shared/chrome.ts',
]);

const sharedImplementationPrefixes = [
  'packages/',
  'src/',
];

const nativeNamespaceNames = new Set(['browser', 'chrome']);
const globalObjectNames = new Set(['globalThis', 'self', 'window']);
const allowedExtensionGlobalPropertyNames = new Set([
  'browser',
  'chrome',
  'clients',
]);
const legacyExtensionSymbolNames = new Set([
  'ChromeLike',
  'getChromeApi',
  'requireChromeApi',
]);
const browserErrorTextPatterns = [
  /receiving end does not exist/iu,
  /message port closed/iu,
  /no (?:tab|frame|document) with id/iu,
  /cannot access contents/iu,
];
const hiddenBuildPropertyNames = new Map([
  ['alias', 'extension build alias can hide a frozen migration edge'],
  [
    'define',
    'extension build define can hide a frozen migration edge behind a global',
  ],
  [
    'load',
    'extension virtual module hook can hide a frozen migration edge',
  ],
  [
    'resolveId',
    'extension virtual module hook can hide a frozen migration edge',
  ],
]);
const trustedRootBuildPlugin = Object.freeze({
  relativePath: 'scripts/vite-browser-runtime-boundary.ts',
  normalizedSha256:
    '719aeb64efb3f06d367e162dcfdf0dc7ee835a89348496c9d0fc47777603bbe2',
  allowedVirtualHooks: new Set(['load', 'resolveId']),
});
const virtualModuleSpecifierPattern = /^(?:#|\0|virtual:)/u;
const rootExtensionBuildInputPattern = /resolve\(\s*repoRoot\s*,\s*['"]src\/(?:background|content|offscreen|popup)\//u;
const ownedBuildInputPatterns = new Map([
  [
    'background',
    /background:\s*resolve\(\s*extensionRoot\s*,\s*['"]src\/background\.ts['"]\s*\)/u,
  ],
  [
    'content',
    /content:\s*resolve\(\s*extensionRoot\s*,\s*['"]src\/content\.ts['"]\s*\)/u,
  ],
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function isAdapterOrCompositionRoot(relativePath) {
  return /^apps\/extension\/src\/(?:capabilities|pipelineHost)\/(?:chrome|firefox)[A-Z]\w*\.(?:ts|tsx)$/u.test(relativePath)
    || /^apps\/extension\/build\/[a-z]\w*Adapter\.(?:ts|tsx)$/u.test(relativePath)
    || compositionRoots.has(relativePath);
}

function isSharedImplementation(relativePath) {
  return sharedImplementationPrefixes.some((prefix) => (
    relativePath.startsWith(prefix)
  ));
}

function addViolation(violations, relativePath, description) {
  violations.push(`${relativePath}: ${description}`);
}

function scriptKindFor(relativePath) {
  if (relativePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (relativePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (
    relativePath.endsWith('.js')
    || relativePath.endsWith('.cjs')
    || relativePath.endsWith('.mjs')
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function parseArchitectureSource(relativePath, source) {
  return ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(relativePath),
  );
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticPropertyName(node) {
  if (!node) return undefined;
  if (
    ts.isIdentifier(node)
    || ts.isStringLiteralLike(node)
    || ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    return staticPropertyName(node.expression);
  }
  return undefined;
}

function isFunctionLikeScope(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function isLexicalScope(node) {
  return ts.isSourceFile(node)
    || ts.isBlock(node)
    || ts.isModuleBlock(node)
    || ts.isCatchClause(node)
    || isFunctionLikeScope(node);
}

function nearestLexicalScope(node) {
  let current = node;
  while (current && !isLexicalScope(current)) current = current.parent;
  return current;
}

function collectBindingIdentifierNames(node, names) {
  if (ts.isIdentifier(node)) {
    names.push(node.text);
    return;
  }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const element of node.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingIdentifierNames(element.name, names);
      }
    }
  }
}

function collectLexicalMetadata(sourceFile) {
  const bindingsByScope = new Map();
  const constantStringsByScope = new Map();

  function bindingsFor(scope) {
    let bindings = bindingsByScope.get(scope);
    if (!bindings) {
      bindings = new Set();
      bindingsByScope.set(scope, bindings);
    }
    return bindings;
  }

  function constantsFor(scope) {
    let constants = constantStringsByScope.get(scope);
    if (!constants) {
      constants = new Map();
      constantStringsByScope.set(scope, constants);
    }
    return constants;
  }

  function addBinding(scope, name, constantValue) {
    if (!scope) return;
    bindingsFor(scope).add(name);
    if (constantValue !== undefined) {
      constantsFor(scope).set(name, constantValue);
    }
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      const scope = nearestLexicalScope(node.parent);
      const names = [];
      collectBindingIdentifierNames(node.name, names);
      const constantValue = (
        ts.isVariableDeclarationList(node.parent)
        && (node.parent.flags & ts.NodeFlags.Const) !== 0
        && node.initializer
      )
        ? stringLiteralValue(node.initializer)
        : undefined;
      for (const name of names) addBinding(scope, name, constantValue);
    } else if (ts.isParameter(node)) {
      const scope = nearestLexicalScope(node.parent);
      const names = [];
      collectBindingIdentifierNames(node.name, names);
      for (const name of names) addBinding(scope, name);
    } else if (
      (
        ts.isFunctionDeclaration(node)
        || ts.isClassDeclaration(node)
        || ts.isInterfaceDeclaration(node)
        || ts.isTypeAliasDeclaration(node)
        || ts.isEnumDeclaration(node)
      )
      && node.name
    ) {
      addBinding(nearestLexicalScope(node.parent), node.name.text);
    } else if (
      ts.isImportClause(node)
      && node.name
    ) {
      addBinding(sourceFile, node.name.text);
    } else if (
      ts.isImportSpecifier(node)
      || ts.isNamespaceImport(node)
    ) {
      addBinding(sourceFile, node.name.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return {
    bindingsByScope,
    constantStringsByScope,
  };
}

function resolveLexicalBinding(metadata, node, name) {
  let current = node.parent;
  while (current) {
    if (isLexicalScope(current)) {
      const bindings = metadata.bindingsByScope.get(current);
      if (bindings?.has(name)) {
        return {
          bound: true,
          constantValue:
            metadata.constantStringsByScope.get(current)?.get(name),
        };
      }
    }
    current = current.parent;
  }
  return { bound: false, constantValue: undefined };
}

function memberPropertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    return staticPropertyName(node.argumentExpression);
  }
  return undefined;
}

function globalMemberChainInfo(node) {
  let current = node;
  let depth = 0;
  while (
    ts.isPropertyAccessExpression(current)
    || ts.isElementAccessExpression(current)
  ) {
    depth += 1;
    const propertyName = memberPropertyName(current);
    const expression = unwrapExpression(current.expression);
    if (
      ts.isIdentifier(expression)
      && globalObjectNames.has(expression.text)
    ) {
      return { depth, firstPropertyName: propertyName };
    }
    current = expression;
  }
  return undefined;
}

function isVariableInitializerCapture(node) {
  let current = node;
  let parent = current.parent;
  while (
    parent
    && (
      ts.isParenthesizedExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isTypeAssertionExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent)
    )
    && parent.expression === current
  ) {
    current = parent;
    parent = current.parent;
  }
  return Boolean(
    parent
    && ts.isVariableDeclaration(parent)
    && parent.initializer === current,
  );
}

function isGlobalObjectExpression(node) {
  const expression = unwrapExpression(node);
  return ts.isIdentifier(expression)
    && globalObjectNames.has(expression.text);
}

function isReflectGlobalAccess(node) {
  if (
    !ts.isCallExpression(node)
    || node.arguments.length < 2
    || !ts.isPropertyAccessExpression(node.expression)
    || !ts.isIdentifier(node.expression.expression)
    || node.expression.expression.text !== 'Reflect'
    || node.expression.name.text !== 'get'
    || !isGlobalObjectExpression(node.arguments[0])
  ) {
    return false;
  }
  return true;
}

function isPropertyNameIdentifier(node) {
  const { parent } = node;
  return (
    (
      (
        ts.isPropertyAccessExpression(parent)
        || ts.isPropertyAssignment(parent)
        || ts.isMethodDeclaration(parent)
        || ts.isMethodSignature(parent)
        || ts.isPropertyDeclaration(parent)
        || ts.isPropertySignature(parent)
        || ts.isGetAccessorDeclaration(parent)
        || ts.isSetAccessorDeclaration(parent)
      )
      && parent.name === node
    )
    || (
      ts.isBindingElement(parent)
      && parent.propertyName === node
    )
    || ts.isImportSpecifier(parent)
    || ts.isExportSpecifier(parent)
  );
}

function isDeclarationNameIdentifier(node) {
  const { parent } = node;
  return (
    (
      (
        ts.isVariableDeclaration(parent)
        || ts.isParameter(parent)
        || ts.isFunctionDeclaration(parent)
        || ts.isFunctionExpression(parent)
        || ts.isClassDeclaration(parent)
        || ts.isClassExpression(parent)
      )
      && parent.name === node
    )
    || (
      ts.isBindingElement(parent)
      && parent.name === node
    )
  );
}

function isGlobalIdentifierUsedAsMemberBase(node) {
  let current = node;
  let parent = current.parent;
  while (
    parent
    && (
      ts.isParenthesizedExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isTypeAssertionExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent)
    )
    && parent.expression === current
  ) {
    current = parent;
    parent = current.parent;
  }
  return Boolean(
    parent
    && (
      (ts.isPropertyAccessExpression(parent) && parent.expression === current)
      || (ts.isElementAccessExpression(parent) && parent.expression === current)
    ),
  );
}

function isWithinReflectGlobalAccess(node) {
  let current = node;
  let parent = current.parent;
  while (
    parent
    && (
      ts.isParenthesizedExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isTypeAssertionExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent)
    )
    && parent.expression === current
  ) {
    current = parent;
    parent = current.parent;
  }
  return Boolean(parent && isReflectGlobalAccess(parent));
}

function isEqualityOperator(kind) {
  return kind === ts.SyntaxKind.EqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsToken
    || kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
}

function isAssignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment
    && kind <= ts.SyntaxKind.LastAssignment;
}

function isDynamicModuleLoadCall(node) {
  return ts.isCallExpression(node)
    && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (
        ts.isIdentifier(node.expression)
        && node.expression.text === 'require'
      )
    );
}

function isControlFlowTextLiteral(node) {
  let current = node;
  while (current.parent && !ts.isSourceFile(current.parent)) {
    const parent = current.parent;
    if (
      ts.isBinaryExpression(parent)
      && (
        isEqualityOperator(parent.operatorToken.kind)
        || parent.operatorToken.kind === ts.SyntaxKind.InKeyword
      )
    ) {
      return true;
    }
    if (ts.isCaseClause(parent)) return true;
    if (
      ts.isCallExpression(parent)
      && ts.isPropertyAccessExpression(parent.expression)
      && /^(?:endsWith|includes|indexOf|match|startsWith|test)$/u.test(
        parent.expression.name.text,
      )
    ) {
      return true;
    }
    if (
      (
        ts.isIfStatement(parent)
        || ts.isWhileStatement(parent)
        || ts.isDoStatement(parent)
        || ts.isConditionalExpression(parent)
        || ts.isSwitchStatement(parent)
      )
      && parent.expression === current
    ) {
      return true;
    }
    if (ts.isStatement(parent)) break;
    current = parent;
  }
  return false;
}

function stringLiteralValue(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function collectAstPolicyDescriptions(relativePath, source) {
  const sourceFile = parseArchitectureSource(relativePath, source);
  const lexicalMetadata = collectLexicalMetadata(sourceFile);
  const descriptions = new Set();
  const adapterOrRoot = isAdapterOrCompositionRoot(relativePath);
  const sharedImplementation = isSharedImplementation(relativePath);
  const extensionAppSource = relativePath.startsWith('apps/extension/src/');
  const extensionBuildSource =
    relativePath === 'apps/extension/vite.config.ts'
    || relativePath.startsWith('apps/extension/build/')
    || relativePath.startsWith('apps/extension/scripts/')
    || relativePath.startsWith('scripts/');
  const trustedRootPlugin =
    relativePath === trustedRootBuildPlugin.relativePath;

  if (trustedRootPlugin) {
    const normalizedSource = source.replace(/\r\n?/gu, '\n');
    const actualHash = createHash('sha256')
      .update(normalizedSource)
      .digest('hex');
    if (actualHash !== trustedRootBuildPlugin.normalizedSha256) {
      descriptions.add(
        'trusted root build plugin changed outside its exact semantic lock',
      );
    }
  }

  function addNativeDescription(description) {
    if (!adapterOrRoot) {
      descriptions.add(description);
    }
  }

  function addHiddenBuildProperty(name) {
    if (
      trustedRootPlugin
      && trustedRootBuildPlugin.allowedVirtualHooks.has(name)
    ) {
      return;
    }
    const description = hiddenBuildPropertyNames.get(name);
    if (description) descriptions.add(description);
  }

  function visit(node) {
    if (
      extensionBuildSource
      && isDynamicModuleLoadCall(node)
    ) {
      descriptions.add(
        'dynamic extension build loading can hide a frozen migration edge',
      );
    }

    if (ts.isIdentifier(node)) {
      if (legacyExtensionSymbolNames.has(node.text)) {
        descriptions.add('legacy ChromeLike compatibility symbol is forbidden');
      }
      if (/^Chrome[A-Z]\w*$/u.test(node.text)) {
        addNativeDescription('native extension API type is adapter-only');
      } else if (
        nativeNamespaceNames.has(node.text)
        && !isPropertyNameIdentifier(node)
        && !isDeclarationNameIdentifier(node)
        && !resolveLexicalBinding(
          lexicalMetadata,
          node,
          node.text,
        ).bound
      ) {
        addNativeDescription('native extension namespace access is adapter-only');
      }
      const lexicalBinding = resolveLexicalBinding(
        lexicalMetadata,
        node,
        node.text,
      );
      if (
        !isDeclarationNameIdentifier(node)
        && lexicalBinding.constantValue !== undefined
        && isControlFlowTextLiteral(node)
      ) {
        if (
          sharedImplementation
          && /^(?:chrome|firefox)$/iu.test(lexicalBinding.constantValue)
        ) {
          descriptions.add(
            'shared implementation contains a browser-specific branch or brand',
          );
        }
        if (
          !adapterOrRoot
          && browserErrorTextPatterns.some(
            (pattern) => pattern.test(lexicalBinding.constantValue),
          )
        ) {
          descriptions.add('browser error text control flow is adapter-only');
        }
      }
      if (
        sharedImplementation
        && /^(?:Chrome|Firefox|isChrome|isFirefox)$/u.test(node.text)
      ) {
        descriptions.add(
          'shared implementation contains a browser-specific branch or brand',
        );
      }
      if (
        extensionAppSource
        && globalObjectNames.has(node.text)
        && !ts.isTypeQueryNode(node.parent)
        && !isGlobalIdentifierUsedAsMemberBase(node)
        && !isWithinReflectGlobalAccess(node)
      ) {
        descriptions.add('global bridge cannot hide a frozen migration edge');
      }
    }

    if (
      ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
      && isGlobalObjectExpression(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const propertyName = staticPropertyName(
          element.propertyName ?? element.name,
        );
        if (nativeNamespaceNames.has(propertyName)) {
          addNativeDescription(
            'native extension namespace access is adapter-only',
          );
        }
      }
    }

    if (
      ts.isPropertyAccessExpression(node)
      || ts.isElementAccessExpression(node)
    ) {
      const propertyName = memberPropertyName(node);
      const globalChain = globalMemberChainInfo(node);
      if (
        extensionAppSource
        && globalChain
        && globalChain.depth > 1
        && allowedExtensionGlobalPropertyNames.has(
          globalChain.firstPropertyName,
        )
      ) {
        descriptions.add('global bridge cannot hide a frozen migration edge');
      }
      if (isGlobalObjectExpression(node.expression)) {
        if (nativeNamespaceNames.has(propertyName)) {
          addNativeDescription(
            'native extension namespace access is adapter-only',
          );
          if (
            extensionAppSource
            && !isVariableInitializerCapture(node)
          ) {
            descriptions.add(
              'global bridge cannot hide a frozen migration edge',
            );
          }
        } else if (
          extensionAppSource
          && !allowedExtensionGlobalPropertyNames.has(propertyName)
        ) {
          descriptions.add('global bridge cannot hide a frozen migration edge');
        }
      }
      if (
        propertyName === 'lastError'
        && (
          (
            ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 'runtime'
          )
          || (
            ts.isElementAccessExpression(node.expression)
            && memberPropertyName(node.expression) === 'runtime'
          )
        )
        && !adapterOrRoot
      ) {
        descriptions.add('browser error text control flow is adapter-only');
      }
    }

    if (isReflectGlobalAccess(node)) {
      const propertyName = staticPropertyName(node.arguments[1]);
      if (
        propertyName === undefined
        || nativeNamespaceNames.has(propertyName)
      ) {
        addNativeDescription(
          'native extension namespace access is adapter-only',
        );
      }
      if (
        extensionAppSource
        && (
          propertyName === undefined
          || nativeNamespaceNames.has(propertyName)
          || !allowedExtensionGlobalPropertyNames.has(propertyName)
        )
      ) {
        descriptions.add('global bridge cannot hide a frozen migration edge');
      }
    }

    const literalValue = stringLiteralValue(node);
    if (literalValue !== undefined) {
      if (
        !adapterOrRoot
        && /\b(?:chrome|moz)-extension:/iu.test(literalValue)
      ) {
        descriptions.add('platform extension URL scheme is adapter-only');
      }
      if (
        !adapterOrRoot
        && browserErrorTextPatterns.some((pattern) => pattern.test(literalValue))
        && isControlFlowTextLiteral(node)
      ) {
        descriptions.add('browser error text control flow is adapter-only');
      }
      if (
        sharedImplementation
        && /^(?:chrome|firefox)$/iu.test(literalValue)
        && isControlFlowTextLiteral(node)
      ) {
        descriptions.add(
          'shared implementation contains a browser-specific branch or brand',
        );
      }
    }

    if (extensionBuildSource) {
      if (
        ts.isPropertyAssignment(node)
        || ts.isShorthandPropertyAssignment(node)
        || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node)
      ) {
        const propertyName = staticPropertyName(node.name);
        if (propertyName === undefined && ts.isComputedPropertyName(node.name)) {
          descriptions.add(
            'computed extension build property can hide a frozen migration edge',
          );
        } else {
          addHiddenBuildProperty(propertyName);
        }
      }
      if (
        ts.isFunctionDeclaration(node)
        && node.name
      ) {
        addHiddenBuildProperty(node.name.text);
      }
      if (
        ts.isBinaryExpression(node)
        && isAssignmentOperator(node.operatorToken.kind)
        && (
          ts.isPropertyAccessExpression(node.left)
          || ts.isElementAccessExpression(node.left)
        )
      ) {
        const propertyName = memberPropertyName(node.left);
        if (
          propertyName === undefined
          && ts.isElementAccessExpression(node.left)
        ) {
          descriptions.add(
            'computed extension build assignment can hide a frozen migration edge',
          );
        } else {
          addHiddenBuildProperty(propertyName);
        }
      }
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && (
          (
            node.expression.expression.text === 'Reflect'
            && node.expression.name.text === 'set'
          )
          || (
            node.expression.expression.text === 'Object'
            && node.expression.name.text === 'defineProperty'
          )
        )
      ) {
        descriptions.add(
          'reflective extension build configuration can hide a frozen migration edge',
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return descriptions;
}

function collectModuleReferences(relativePath, source) {
  const sourceFile = parseArchitectureSource(relativePath, source);
  const references = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      references.push({
        kind: 'static',
        specifier: node.moduleSpecifier.text,
      });
    } else if (ts.isCallExpression(node)) {
      if (isDynamicModuleLoadCall(node)) {
        const argument = node.arguments[0];
        references.push({
          kind: 'dynamic',
          specifier: argument && ts.isStringLiteralLike(argument)
            ? argument.text
            : undefined,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function targetsLegacyRootSource(relativePath, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return false;
  const pathOnly = specifier.split(/[?#]/u, 1)[0];
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relativePath), pathOnly),
  );
  return resolved === 'src' || resolved.startsWith('src/');
}

function collectFrozenMigrationEdgeViolations(files, requireComplete) {
  const violations = [];
  let approvedEdgeCount = 0;

  for (const file of files) {
    const relativePath = toPosix(file.relativePath);
    if (
      !relativePath.startsWith('apps/extension/')
      && relativePath !== trustedRootBuildPlugin.relativePath
    ) {
      continue;
    }

    const references = collectModuleReferences(relativePath, file.source);
    const expectedTarget = frozenExtensionMigrationEdges.get(relativePath);
    const allowedImports = allowedFrozenRootImports.get(relativePath);

    for (const description of collectAstPolicyDescriptions(
      relativePath,
      file.source,
    )) {
      if (
        description.includes('hide a frozen migration edge')
        || description.startsWith('global bridge')
        || description.includes('semantic lock')
      ) {
        addViolation(violations, relativePath, description);
      }
    }

    for (const reference of references) {
      if (
        typeof reference.specifier === 'string'
        && virtualModuleSpecifierPattern.test(reference.specifier)
      ) {
        addViolation(
          violations,
          relativePath,
          'virtual module cannot hide a frozen migration edge',
        );
      }
      if (
        relativePath.startsWith('apps/extension/src/')
        && reference.kind === 'dynamic'
      ) {
        addViolation(
          violations,
          relativePath,
          'extension app source forbids dynamic module loading while frozen migration edges exist',
        );
      }
    }

    if (expectedTarget !== undefined) {
      let expectedStaticImportCount = 0;
      for (const reference of references) {
        if (
          reference.kind === 'static'
          && reference.specifier === expectedTarget
        ) {
          expectedStaticImportCount += 1;
          approvedEdgeCount += 1;
        }
        if (reference.kind === 'dynamic') {
          addViolation(
            violations,
            relativePath,
            'frozen migration composition roots forbid dynamic import and require indirection',
          );
        } else if (!allowedImports.has(reference.specifier)) {
          addViolation(
            violations,
            relativePath,
            'frozen migration composition root import is not explicitly allowed; aliases and virtual modules are forbidden',
          );
        }
      }
      if (
        (requireComplete || files.some(
          (candidate) => toPosix(candidate.relativePath) === relativePath,
        ))
        && expectedStaticImportCount !== 1
      ) {
        addViolation(
          violations,
          relativePath,
          `frozen migration edge to ${expectedTarget} must exist exactly once as a static import; `
          + frozenExtensionMigrationRemovalCondition.action,
        );
      }
    }

    for (const reference of references) {
      if (!targetsLegacyRootSource(relativePath, reference.specifier)) continue;
      const edgeKey = `${relativePath} -> ${reference.specifier}`;
      if (
        reference.kind === 'static'
        && grandfatheredLegacyExtensionRootEdgeKeys.has(edgeKey)
      ) {
        continue;
      }
      if (
        reference.kind === 'static'
        && reference.specifier === expectedTarget
      ) {
        continue;
      }
      addViolation(
        violations,
        relativePath,
        'only the two frozen background/content app-to-root migration edges are allowed',
      );
    }

  }

  if (requireComplete) {
    for (const [source, target] of frozenExtensionMigrationEdges) {
      if (!files.some((file) => toPosix(file.relativePath) === source)) {
        addViolation(
          violations,
          source,
          `frozen migration edge to ${target} is missing; `
          + frozenExtensionMigrationRemovalCondition.action,
        );
      }
    }
    if (approvedEdgeCount !== frozenExtensionMigrationEdges.size) {
      addViolation(
        violations,
        'apps/extension',
        `frozen migration edge count must be exactly ${frozenExtensionMigrationEdges.size}`,
      );
    }
  }

  return violations.sort();
}

export function findFrozenMigrationEdgeViolations(files) {
  return collectFrozenMigrationEdgeViolations(files, true);
}

export function findSourcePolicyViolations(files) {
  const violations = collectFrozenMigrationEdgeViolations(files, false);

  for (const file of files) {
    const relativePath = toPosix(file.relativePath);
    const { source } = file;

    if (legacyExtensionSeams.has(relativePath)) {
      addViolation(
        violations,
        relativePath,
        'legacy Chrome-shaped WebExtension seam must be deleted',
      );
    }
    for (const description of collectAstPolicyDescriptions(
      relativePath,
      source,
    )) {
      addViolation(violations, relativePath, description);
    }
  }

  return [...new Set(violations)].sort();
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function collectSourceFiles(repositoryRoot, directory) {
  const absoluteDirectory = path.join(repositoryRoot, directory);
  if (!await pathExists(absoluteDirectory)) return [];

  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const relativePath = toPosix(path.relative(repositoryRoot, absolutePath));
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(repositoryRoot, relativePath));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push({
        relativePath,
        source: await readFile(absolutePath, 'utf8'),
      });
    }
  }
  return files;
}

async function fileExists(target) {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function resolveLocalSourceModule(
  repositoryRoot,
  importerRelativePath,
  specifier,
) {
  if (!specifier.startsWith('.')) return undefined;
  const pathOnly = specifier.split(/[?#]/u, 1)[0];
  const unresolved = path.resolve(
    repositoryRoot,
    path.dirname(importerRelativePath),
    pathOnly,
  );
  const candidates = path.extname(unresolved)
    ? [unresolved]
    : [
        ...[...sourceExtensions].map((extension) => (
          `${unresolved}${extension}`
        )),
        ...[...sourceExtensions].map((extension) => (
          path.join(unresolved, `index${extension}`)
        )),
      ];

  for (const candidate of candidates) {
    const relativePath = toPosix(path.relative(repositoryRoot, candidate));
    if (
      relativePath === '..'
      || relativePath.startsWith('../')
      || path.isAbsolute(relativePath)
    ) {
      continue;
    }
    if (await fileExists(candidate)) return relativePath;
  }
  return undefined;
}

async function collectLocalSourceImportGraph(repositoryRoot, entryPath) {
  const queued = [entryPath];
  const files = new Map();

  while (queued.length > 0) {
    const relativePath = queued.shift();
    if (files.has(relativePath)) continue;
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (!await fileExists(absolutePath)) continue;
    const source = await readFile(absolutePath, 'utf8');
    files.set(relativePath, { relativePath, source });

    for (const reference of collectModuleReferences(relativePath, source)) {
      if (
        reference.kind !== 'static'
        || typeof reference.specifier !== 'string'
      ) {
        continue;
      }
      const resolved = await resolveLocalSourceModule(
        repositoryRoot,
        relativePath,
        reference.specifier,
      );
      if (resolved && !files.has(resolved)) queued.push(resolved);
    }
  }

  return [...files.values()];
}

export async function scanExtensionArchitecture(repositoryRoot) {
  const collectedFiles = [
    ...await collectSourceFiles(repositoryRoot, 'apps/extension/build'),
    ...await collectSourceFiles(repositoryRoot, 'apps/extension/scripts'),
    ...await collectSourceFiles(repositoryRoot, 'apps/extension/src'),
    ...await collectSourceFiles(repositoryRoot, 'packages'),
    ...await collectSourceFiles(repositoryRoot, 'src'),
    ...await collectLocalSourceImportGraph(
      repositoryRoot,
      'apps/extension/vite.config.ts',
    ),
  ];
  const files = [...new Map(
    collectedFiles.map((file) => [file.relativePath, file]),
  ).values()];
  const viteConfig = files.find(
    (file) => file.relativePath === 'apps/extension/vite.config.ts',
  )?.source;

  const violations = [
    ...findSourcePolicyViolations(files),
    ...findFrozenMigrationEdgeViolations(files),
  ];

  for (const compositionRoot of compositionRoots) {
    if (!files.some((file) => file.relativePath === compositionRoot)) {
      addViolation(
        violations,
        compositionRoot,
        'extension composition root must be owned by apps/extension',
      );
    }
  }

  if (viteConfig !== undefined) {
    if (rootExtensionBuildInputPattern.test(viteConfig)) {
      addViolation(
        violations,
        'apps/extension/vite.config.ts',
        'extension build inputs must be owned by apps/extension',
      );
    }
    for (const [entryName, pattern] of ownedBuildInputPatterns) {
      if (!pattern.test(viteConfig)) {
        addViolation(
          violations,
          'apps/extension/vite.config.ts',
          `${entryName} build input must use its apps/extension composition root`,
        );
      }
    }
  }

  for (const relativeTsconfigPath of [
    'tsconfig.json',
    'apps/extension/tsconfig.json',
  ]) {
    const tsconfigPath = path.join(repositoryRoot, relativeTsconfigPath);
    if (!await pathExists(tsconfigPath)) continue;
    const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8'));
    const compilerOptions = tsconfig?.compilerOptions;
    if (
      compilerOptions
      && (
        typeof compilerOptions.baseUrl === 'string'
        || (
          compilerOptions.paths
          && Object.keys(compilerOptions.paths).length > 0
        )
      )
    ) {
      addViolation(
        violations,
        relativeTsconfigPath,
        'TypeScript path aliases cannot hide frozen extension migration edges',
      );
    }
  }

  return [...new Set(violations)].sort();
}
