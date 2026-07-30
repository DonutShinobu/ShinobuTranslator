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
const hiddenCodeGenerationNames = new Set(['eval', 'Function']);
const reflectGetNames = new Set(['get']);
const reflectCodeGenerationInvocationNames = new Set([
  'apply',
  'construct',
]);
const reflectCodeGenerationMemberNames = new Set([
  ...reflectGetNames,
  ...reflectCodeGenerationInvocationNames,
]);
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

function collectBindingIdentifiers(node, identifiers) {
  if (ts.isIdentifier(node)) {
    identifiers.push(node);
    return;
  }
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    for (const element of node.elements) {
      if (ts.isBindingElement(element)) {
        collectBindingIdentifiers(element.name, identifiers);
      }
    }
  }
}

function collectLexicalMetadata(sourceFile, relativePath) {
  const bindingsByScope = new Map();
  const codeGenerationAliasesByScope = new Map();
  const commonJsModuleNamespacesByScope = new Map();
  const constantStringsByScope = new Map();
  const createRequireFunctionsByScope = new Map();
  const fileUrlToPathFunctionsByScope = new Map();
  const globalAliasesByScope = new Map();
  const moduleLoaderAliasesByScope = new Map();
  const nativeNamespaceAliasesByScope = new Map();
  const nodeModuleNamespacesByScope = new Map();
  const pathAnchorsByScope = new Map();
  const pathFunctionsByScope = new Map();
  const pathNamespacesByScope = new Map();
  const reflectFunctionsByScope = new Map();
  const reflectNamespacesByScope = new Map();
  const safeConstructorReceiversByScope = new Map();
  const stableInitializersByScope = new Map();
  const functionDeclarationsByScope = new Map();
  const classDeclarationsByScope = new Map();
  const urlBaseDirectoriesByScope = new Map();
  const pendingBindings = [];
  const pendingDestructuredBindings = [];

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

  function createRequireFunctionsFor(scope) {
    let functions = createRequireFunctionsByScope.get(scope);
    if (!functions) {
      functions = new Set();
      createRequireFunctionsByScope.set(scope, functions);
    }
    return functions;
  }

  function fileUrlToPathFunctionsFor(scope) {
    let functions = fileUrlToPathFunctionsByScope.get(scope);
    if (!functions) {
      functions = new Set();
      fileUrlToPathFunctionsByScope.set(scope, functions);
    }
    return functions;
  }

  function commonJsModuleNamespacesFor(scope) {
    let namespaces = commonJsModuleNamespacesByScope.get(scope);
    if (!namespaces) {
      namespaces = new Set();
      commonJsModuleNamespacesByScope.set(scope, namespaces);
    }
    return namespaces;
  }

  function moduleLoaderAliasesFor(scope) {
    let aliases = moduleLoaderAliasesByScope.get(scope);
    if (!aliases) {
      aliases = new Set();
      moduleLoaderAliasesByScope.set(scope, aliases);
    }
    return aliases;
  }

  function nativeNamespaceAliasesFor(scope) {
    let aliases = nativeNamespaceAliasesByScope.get(scope);
    if (!aliases) {
      aliases = new Set();
      nativeNamespaceAliasesByScope.set(scope, aliases);
    }
    return aliases;
  }

  function nodeModuleNamespacesFor(scope) {
    let namespaces = nodeModuleNamespacesByScope.get(scope);
    if (!namespaces) {
      namespaces = new Set();
      nodeModuleNamespacesByScope.set(scope, namespaces);
    }
    return namespaces;
  }

  function addBinding(scope, name) {
    if (!scope) return;
    bindingsFor(scope).add(name);
  }

  function globalAliasesFor(scope) {
    let aliases = globalAliasesByScope.get(scope);
    if (!aliases) {
      aliases = new Set();
      globalAliasesByScope.set(scope, aliases);
    }
    return aliases;
  }

  function codeGenerationAliasesFor(scope) {
    let aliases = codeGenerationAliasesByScope.get(scope);
    if (!aliases) {
      aliases = new Set();
      codeGenerationAliasesByScope.set(scope, aliases);
    }
    return aliases;
  }

  function pathAnchorsFor(scope) {
    let anchors = pathAnchorsByScope.get(scope);
    if (!anchors) {
      anchors = new Map();
      pathAnchorsByScope.set(scope, anchors);
    }
    return anchors;
  }

  function pathFunctionsFor(scope) {
    let functions = pathFunctionsByScope.get(scope);
    if (!functions) {
      functions = new Map();
      pathFunctionsByScope.set(scope, functions);
    }
    return functions;
  }

  function pathNamespacesFor(scope) {
    let namespaces = pathNamespacesByScope.get(scope);
    if (!namespaces) {
      namespaces = new Set();
      pathNamespacesByScope.set(scope, namespaces);
    }
    return namespaces;
  }

  function reflectFunctionsFor(scope) {
    let functions = reflectFunctionsByScope.get(scope);
    if (!functions) {
      functions = new Map();
      reflectFunctionsByScope.set(scope, functions);
    }
    return functions;
  }

  function reflectNamespacesFor(scope) {
    let namespaces = reflectNamespacesByScope.get(scope);
    if (!namespaces) {
      namespaces = new Set();
      reflectNamespacesByScope.set(scope, namespaces);
    }
    return namespaces;
  }

  function safeConstructorReceiversFor(scope) {
    let receivers = safeConstructorReceiversByScope.get(scope);
    if (!receivers) {
      receivers = new Set();
      safeConstructorReceiversByScope.set(scope, receivers);
    }
    return receivers;
  }

  function urlBaseDirectoriesFor(scope) {
    let directories = urlBaseDirectoriesByScope.get(scope);
    if (!directories) {
      directories = new Map();
      urlBaseDirectoriesByScope.set(scope, directories);
    }
    return directories;
  }

  function stableInitializersFor(scope) {
    let initializers = stableInitializersByScope.get(scope);
    if (!initializers) {
      initializers = new Map();
      stableInitializersByScope.set(scope, initializers);
    }
    return initializers;
  }

  function functionDeclarationsFor(scope) {
    let declarations = functionDeclarationsByScope.get(scope);
    if (!declarations) {
      declarations = new Map();
      functionDeclarationsByScope.set(scope, declarations);
    }
    return declarations;
  }

  function classDeclarationsFor(scope) {
    let declarations = classDeclarationsByScope.get(scope);
    if (!declarations) {
      declarations = new Map();
      classDeclarationsByScope.set(scope, declarations);
    }
    return declarations;
  }

  function queueBinding(
    scope,
    name,
    initializer,
    trackString = false,
    stable = false,
    declaration = true,
  ) {
    if (!scope || !initializer) return;
    pendingBindings.push({
      initializer,
      name,
      scope,
      targetNode: undefined,
      trackString,
      stable,
      declaration,
    });
  }

  function queueDestructuredBinding(
    scope,
    targetNode,
    propertyNameNode,
    initializer,
    stable = false,
    rest = false,
  ) {
    if (!ts.isIdentifier(targetNode)) return;
    pendingDestructuredBindings.push({
      initializer,
      name: targetNode.text,
      propertyNameNode,
      scope,
      targetNode: scope ? undefined : targetNode,
      stable,
      rest,
    });
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      const scope = nearestLexicalScope(node.parent);
      const names = [];
      collectBindingIdentifierNames(node.name, names);
      const trackString = (
        ts.isVariableDeclarationList(node.parent)
        && (node.parent.flags & ts.NodeFlags.Const) !== 0
      );
      for (const name of names) {
        addBinding(scope, name);
      }
      if (
        ts.isIdentifier(node.name)
        && node.initializer
      ) {
        if (trackString) {
          stableInitializersFor(scope).set(
            node.name.text,
            node.initializer,
          );
        }
        queueBinding(
          scope,
          node.name.text,
          node.initializer,
          trackString,
          trackString,
        );
      }
      if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        for (const element of node.name.elements) {
          queueDestructuredBinding(
            scope,
            element.name,
            element.propertyName ?? element.name,
            node.initializer,
            trackString,
            Boolean(element.dotDotDotToken),
          );
        }
      }
      if (ts.isArrayBindingPattern(node.name) && node.initializer) {
        node.name.elements.forEach((element, index) => {
          if (!ts.isBindingElement(element)) return;
          queueDestructuredBinding(
            scope,
            element.name,
            ts.factory.createNumericLiteral(index),
            node.initializer,
            trackString,
            Boolean(element.dotDotDotToken),
          );
        });
      }
    } else if (ts.isParameter(node)) {
      const scope = nearestLexicalScope(node.parent);
      const names = [];
      collectBindingIdentifierNames(node.name, names);
      for (const name of names) {
        addBinding(scope, name);
      }
      if (ts.isIdentifier(node.name) && node.initializer) {
        queueBinding(scope, node.name.text, node.initializer);
      }
      if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        for (const element of node.name.elements) {
          queueDestructuredBinding(
            scope,
            element.name,
            element.propertyName ?? element.name,
            node.initializer,
            false,
            Boolean(element.dotDotDotToken),
          );
        }
      }
      if (ts.isArrayBindingPattern(node.name) && node.initializer) {
        node.name.elements.forEach((element, index) => {
          if (!ts.isBindingElement(element)) return;
          queueDestructuredBinding(
            scope,
            element.name,
            ts.factory.createNumericLiteral(index),
            node.initializer,
            false,
            Boolean(element.dotDotDotToken),
          );
        });
      }
    } else if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(unwrapExpression(node.left))
    ) {
      const targetNode = unwrapExpression(node.left);
      pendingBindings.push({
        initializer: node.right,
        name: targetNode.text,
        scope: undefined,
        targetNode,
        trackString: false,
        stable: false,
        declaration: false,
      });
    } else if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isObjectLiteralExpression(unwrapExpression(node.left))
    ) {
      for (const property of unwrapExpression(node.left).properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          queueDestructuredBinding(
            undefined,
            property.name,
            property.name,
            node.right,
            false,
            Boolean(property.dotDotDotToken),
          );
        } else if (ts.isPropertyAssignment(property)) {
          queueDestructuredBinding(
            undefined,
            unwrapExpression(property.initializer),
            property.name,
            node.right,
          );
        }
      }
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
      const scope = nearestLexicalScope(node.parent);
      addBinding(scope, node.name.text);
      if (ts.isFunctionDeclaration(node)) {
        functionDeclarationsFor(scope).set(node.name.text, node);
      } else if (ts.isClassDeclaration(node)) {
        classDeclarationsFor(scope).set(node.name.text, node);
      }
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
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && node.moduleSpecifier.text === 'node:path'
      && node.importClause
    ) {
      if (node.importClause.name) {
        pathNamespacesFor(sourceFile).add(node.importClause.name.text);
      }
      const namedBindings = node.importClause.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        pathNamespacesFor(sourceFile).add(namedBindings.name.text);
      } else if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          if (importedName === 'join' || importedName === 'resolve') {
            pathFunctionsFor(sourceFile).set(
              element.name.text,
              importedName,
            );
          } else if (importedName === 'sep') {
            constantsFor(sourceFile).set(element.name.text, '/');
          }
        }
      }
    }
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && node.moduleSpecifier.text === 'node:url'
      && node.importClause?.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        if (
          (element.propertyName ?? element.name).text
          === 'fileURLToPath'
        ) {
          fileUrlToPathFunctionsFor(sourceFile).add(element.name.text);
        }
      }
    }
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && node.moduleSpecifier.text === 'node:module'
      && node.importClause
    ) {
      if (node.importClause.name) {
        nodeModuleNamespacesFor(sourceFile).add(
          node.importClause.name.text,
        );
      }
      const namedBindings = node.importClause.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        nodeModuleNamespacesFor(sourceFile).add(
          namedBindings.name.text,
        );
      } else if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if (
            (element.propertyName ?? element.name).text
            === 'createRequire'
          ) {
            createRequireFunctionsFor(sourceFile).add(
              element.name.text,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  const metadata = {
    bindingsByScope,
    codeGenerationAliasesByScope,
    classDeclarationsByScope,
    commonJsModuleNamespacesByScope,
    constantStringsByScope,
    createRequireFunctionsByScope,
    globalAliasesByScope,
    moduleLoaderAliasesByScope,
    nativeNamespaceAliasesByScope,
    nodeModuleNamespacesByScope,
    pathAnchorsByScope,
    pathFunctionsByScope,
    pathNamespacesByScope,
    reflectFunctionsByScope,
    reflectNamespacesByScope,
    relativePath,
    safeConstructorReceiversByScope,
    sourceFile,
    stableInitializersByScope,
    functionDeclarationsByScope,
    fileUrlToPathFunctionsByScope,
    urlBaseDirectoriesByScope,
  };
  let changed;
  do {
    changed = false;
    for (const pending of pendingBindings) {
      let scope = pending.scope;
      if (!scope && pending.targetNode) {
        scope = resolveLexicalBinding(
          metadata,
          pending.targetNode,
          pending.name,
        ).scope;
        if (!scope) {
          scope = sourceFile;
          addBinding(scope, pending.name);
        }
      }
      if (!scope) continue;
      const stableCapabilityBinding = pending.declaration
        && !bindingHasReassignment(
          metadata,
          scope,
          pending.name,
        );

      const aliases = globalAliasesFor(scope);
      if (
        !aliases.has(pending.name)
        && expressionIsGlobalAlias(metadata, pending.initializer)
      ) {
        aliases.add(pending.name);
        changed = true;
      }
      if (
        !codeGenerationAliasesFor(scope).has(pending.name)
        && expressionIsCodeGenerationCallable(
          pending.initializer,
          metadata,
        )
      ) {
        codeGenerationAliasesFor(scope).add(pending.name);
        changed = true;
      }
      if (
        !nativeNamespaceAliasesFor(scope).has(pending.name)
        && expressionIsNativeNamespaceValue(
          pending.initializer,
          metadata,
        )
      ) {
        nativeNamespaceAliasesFor(scope).add(pending.name);
        changed = true;
      }
      if (
        pending.trackString
        && !constantsFor(scope).has(pending.name)
      ) {
        const value = staticStringExpressionValue(
          pending.initializer,
          metadata,
        );
        if (value !== undefined) {
          constantsFor(scope).set(pending.name, value);
          changed = true;
        }
      }
      {
        const anchor = buildPathExpressionValue(
          pending.initializer,
          metadata,
        );
        if (anchor !== undefined) {
          const anchors = pathAnchorsFor(scope);
          const merged = mergeBuildPathAnchorValues(
            anchors.get(pending.name),
            anchor,
          );
          if (anchors.get(pending.name) !== merged) {
            anchors.set(pending.name, merged);
            changed = true;
          }
        }
      }
      if (
        pending.stable
        && !safeConstructorReceiversFor(scope).has(pending.name)
        && expressionHasProvenSafeOwnConstructor(
          pending.initializer,
          metadata,
        )
        && safeConstructorReceiverHasNoOpaqueMutation(
          metadata,
          scope,
          pending.name,
        )
      ) {
        safeConstructorReceiversFor(scope).add(pending.name);
        changed = true;
      }
      {
        const directory = buildUrlBaseDirectoryValue(
          pending.initializer,
          metadata,
        );
        if (directory !== undefined) {
          const directories = urlBaseDirectoriesFor(scope);
          const merged = mergeBuildPathAnchorValues(
            directories.get(pending.name),
            directory,
          );
          if (directories.get(pending.name) !== merged) {
            directories.set(pending.name, merged);
            changed = true;
          }
        }
      }
      if (!pathFunctionsFor(scope).has(pending.name)) {
        const functionKind = nodePathFunctionKind(
          pending.initializer,
          metadata,
        );
        if (functionKind !== undefined) {
          pathFunctionsFor(scope).set(pending.name, functionKind);
          changed = true;
        }
      }
      if (
        !pathNamespacesFor(scope).has(pending.name)
        && expressionIsNodePathNamespace(
          pending.initializer,
          metadata,
        )
      ) {
        pathNamespacesFor(scope).add(pending.name);
        changed = true;
      }
      if (
        stableCapabilityBinding
        && !reflectFunctionsFor(scope).has(pending.name)
      ) {
        const reflectKind = reflectFunctionKind(
          pending.initializer,
          metadata,
        );
        if (reflectKind !== undefined) {
          reflectFunctionsFor(scope).set(pending.name, reflectKind);
          changed = true;
        }
      }
      if (
        stableCapabilityBinding
        && !reflectNamespacesFor(scope).has(pending.name)
        && expressionIsUnshadowedReflectNamespace(
          pending.initializer,
          metadata,
        )
      ) {
        reflectNamespacesFor(scope).add(pending.name);
        changed = true;
      }
      if (
        stableCapabilityBinding
        && !createRequireFunctionsFor(scope).has(pending.name)
        && expressionIsCreateRequireFunction(
          pending.initializer,
          metadata,
        )
      ) {
        createRequireFunctionsFor(scope).add(pending.name);
        changed = true;
      }
      if (
        stableCapabilityBinding
        && !moduleLoaderAliasesFor(scope).has(pending.name)
        && expressionIsModuleLoader(
          pending.initializer,
          metadata,
        )
      ) {
        moduleLoaderAliasesFor(scope).add(pending.name);
        changed = true;
      }
      if (
        stableCapabilityBinding
        && !commonJsModuleNamespacesFor(scope).has(pending.name)
        && expressionIsCommonJsModuleNamespace(
          pending.initializer,
          metadata,
        )
      ) {
        commonJsModuleNamespacesFor(scope).add(pending.name);
        changed = true;
      }
      if (
        stableCapabilityBinding
        && !nodeModuleNamespacesFor(scope).has(pending.name)
        && expressionIsNodeModuleNamespace(
          pending.initializer,
          metadata,
        )
      ) {
        nodeModuleNamespacesFor(scope).add(pending.name);
        changed = true;
      }
    }
    for (const pending of pendingDestructuredBindings) {
      let scope = pending.scope;
      if (!scope && pending.targetNode) {
        scope = resolveLexicalBinding(
          metadata,
          pending.targetNode,
          pending.name,
        ).scope;
        if (!scope) {
          scope = sourceFile;
          addBinding(scope, pending.name);
        }
      }
      if (!scope) continue;
      if (pending.rest) {
        if (
          expressionIsNodeModuleNamespace(
            pending.initializer,
            metadata,
          )
          && !nodeModuleNamespacesFor(scope).has(pending.name)
        ) {
          nodeModuleNamespacesFor(scope).add(pending.name);
          changed = true;
        }
        if (
          expressionIsCommonJsModuleNamespace(
            pending.initializer,
            metadata,
          )
          && !commonJsModuleNamespacesFor(scope).has(pending.name)
        ) {
          commonJsModuleNamespacesFor(scope).add(pending.name);
          changed = true;
        }
        if (
          expressionIsGlobalAlias(metadata, pending.initializer)
          && !globalAliasesFor(scope).has(pending.name)
        ) {
          globalAliasesFor(scope).add(pending.name);
          changed = true;
        }
        if (
          expressionIsUnshadowedReflectNamespace(
            pending.initializer,
            metadata,
          )
          && !reflectNamespacesFor(scope).has(pending.name)
        ) {
          reflectNamespacesFor(scope).add(pending.name);
          changed = true;
        }
        continue;
      }
      const propertyName = staticPropertyNameValue(
        pending.propertyNameNode,
        metadata,
      );
      if (propertyName === undefined) continue;
      const containerValue = buildContainerPropertyExpression(
        pending.initializer,
        propertyName,
        metadata,
      );
      const destructuredPathAnchor = propertyName === 'pathname'
        ? buildUrlObjectPathValue(pending.initializer, metadata)
        : containerValue
          ? buildPathExpressionValue(containerValue, metadata)
          : undefined;
      if (
        destructuredPathAnchor !== undefined
        && !pathAnchorsFor(scope).has(pending.name)
      ) {
        pathAnchorsFor(scope).set(
          pending.name,
          destructuredPathAnchor,
        );
        changed = true;
      }
      if (containerValue) {
        const urlDirectory = buildUrlBaseDirectoryValue(
          containerValue,
          metadata,
        );
        if (
          urlDirectory !== undefined
          && !urlBaseDirectoriesFor(scope).has(pending.name)
        ) {
          urlBaseDirectoriesFor(scope).set(
            pending.name,
            urlDirectory,
          );
          changed = true;
        }
      }
      if (
        propertyName === 'value'
        && expressionIsFunctionConstructorDescriptor(
          pending.initializer,
          metadata,
        )
        && !codeGenerationAliasesFor(scope).has(pending.name)
      ) {
        codeGenerationAliasesFor(scope).add(pending.name);
        changed = true;
      }

      if (
        globalObjectNames.has(propertyName)
        && expressionIsGlobalAlias(metadata, pending.initializer)
        && !globalAliasesFor(scope).has(pending.name)
      ) {
        globalAliasesFor(scope).add(pending.name);
        changed = true;
      }
      if (
        (
          propertyName === 'constructor'
          && !expressionHasProvenSafeOwnConstructor(
            pending.initializer,
            metadata,
          )
          || (
            hiddenCodeGenerationNames.has(propertyName)
            && expressionIsGlobalAlias(
              metadata,
              pending.initializer,
            )
          )
        )
        && !codeGenerationAliasesFor(scope).has(pending.name)
      ) {
        codeGenerationAliasesFor(scope).add(pending.name);
        changed = true;
      }
      if (
        (propertyName === 'join'
          || propertyName === 'resolve')
        && expressionIsNodePathNamespace(
          pending.initializer,
          metadata,
        )
        && !pathFunctionsFor(scope).has(pending.name)
      ) {
        pathFunctionsFor(scope).set(
          pending.name,
          propertyName,
        );
        changed = true;
      }
      if (
        (propertyName === 'posix'
          || propertyName === 'win32')
        && expressionIsNodePathNamespace(
          pending.initializer,
          metadata,
        )
        && !pathNamespacesFor(scope).has(pending.name)
      ) {
        pathNamespacesFor(scope).add(pending.name);
        changed = true;
      }
      if (
        propertyName === 'sep'
        && expressionIsNodePathNamespace(
          pending.initializer,
          metadata,
        )
        && !constantsFor(scope).has(pending.name)
      ) {
        constantsFor(scope).set(pending.name, '/');
        changed = true;
      }
      if (
        pending.stable
        && reflectCodeGenerationMemberNames.has(propertyName)
        && expressionIsUnshadowedReflectNamespace(
          pending.initializer,
          metadata,
        )
        && !reflectFunctionsFor(scope).has(pending.name)
      ) {
        reflectFunctionsFor(scope).set(pending.name, propertyName);
        changed = true;
      }
      if (
        propertyName === 'require'
        && expressionIsCommonJsModuleNamespace(
          pending.initializer,
          metadata,
        )
        && !moduleLoaderAliasesFor(scope).has(pending.name)
      ) {
        moduleLoaderAliasesFor(scope).add(pending.name);
        changed = true;
      }
      if (
        propertyName === 'createRequire'
        && expressionIsNodeModuleNamespace(
          pending.initializer,
          metadata,
        )
        && !createRequireFunctionsFor(scope).has(pending.name)
      ) {
        createRequireFunctionsFor(scope).add(pending.name);
        changed = true;
      }
    }
  } while (changed);

  return metadata;
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
          pathAnchor:
            metadata.pathAnchorsByScope.get(current)?.get(name),
          initializer:
            metadata.stableInitializersByScope.get(current)?.get(name),
          functionDeclaration:
            metadata.functionDeclarationsByScope.get(current)?.get(name),
          classDeclaration:
            metadata.classDeclarationsByScope.get(current)?.get(name),
          scope: current,
        };
      }
    }
    current = current.parent;
  }
  return {
    bound: false,
    constantValue: undefined,
    classDeclaration: undefined,
    functionDeclaration: undefined,
    initializer: undefined,
    pathAnchor: undefined,
    scope: undefined,
  };
}

function resolveGlobalAlias(metadata, node, name) {
  const binding = resolveLexicalBinding(metadata, node, name);
  return Boolean(
    binding.scope
    && metadata.globalAliasesByScope.get(binding.scope)?.has(name),
  );
}

function bindingHasReassignment(
  lexicalMetadata,
  bindingScope,
  bindingName,
) {
  let reassigned = false;
  function visit(node) {
    if (reassigned) return;
    if (
      ts.isBinaryExpression(node)
      && isAssignmentOperator(node.operatorToken.kind)
      && ts.isIdentifier(unwrapExpression(node.left))
    ) {
      const target = unwrapExpression(node.left);
      if (target.text === bindingName) {
        const binding = resolveLexicalBinding(
          lexicalMetadata,
          target,
          bindingName,
        );
        if (binding.scope === bindingScope) reassigned = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(lexicalMetadata.sourceFile);
  return reassigned;
}

function safeConstructorReceiverHasNoOpaqueMutation(
  lexicalMetadata,
  bindingScope,
  bindingName,
) {
  let safe = true;
  function visit(node) {
    if (!safe) return;
    if (ts.isIdentifier(node) && node.text === bindingName) {
      const binding = resolveLexicalBinding(
        lexicalMetadata,
        node,
        bindingName,
      );
      if (binding.scope === bindingScope) {
        const parent = node.parent;
        const escapeKind = valueEscapeKind(
          node,
          (candidate) => {
            const expression = unwrapExpression(candidate);
            if (
              !ts.isIdentifier(expression)
              || expression.text !== bindingName
            ) {
              return false;
            }
            return resolveLexicalBinding(
              lexicalMetadata,
              expression,
              bindingName,
            ).scope === bindingScope;
          },
        );
        if (
          escapeKind !== undefined
          && escapeKind !== 'opaque-call'
        ) {
          safe = false;
          return;
        }
        if (
          ts.isVariableDeclaration(parent)
          && parent.initializer === node
        ) {
          safe = false;
          return;
        }
        if (
          ts.isBinaryExpression(parent)
          && isAssignmentOperator(parent.operatorToken.kind)
          && parent.right === node
        ) {
          safe = false;
          return;
        }
        if (
          (ts.isCallExpression(parent) || ts.isNewExpression(parent))
          && parent.arguments?.includes(node)
        ) {
          const reflectRead = ts.isCallExpression(parent)
            && parent.arguments[0] === node
            && reflectFunctionKind(
              parent.expression,
              lexicalMetadata,
            ) === 'get';
          const objectFreeze = ts.isCallExpression(parent)
            && ts.isPropertyAccessExpression(parent.expression)
            && ts.isIdentifier(parent.expression.expression)
            && parent.expression.expression.text === 'Object'
            && parent.expression.name.text === 'freeze'
            && !resolveLexicalBinding(
              lexicalMetadata,
              parent.expression.expression,
              'Object',
            ).bound;
          if (!reflectRead && !objectFreeze) safe = false;
        }
        if (
          (
            ts.isPropertyAccessExpression(parent)
            || ts.isElementAccessExpression(parent)
          )
          && parent.expression === node
        ) {
          const grandparent = parent.parent;
          const propertyName = memberPropertyName(
            parent,
            lexicalMetadata,
          );
          if (
            (
              ts.isBinaryExpression(grandparent)
              && grandparent.left === parent
              && isAssignmentOperator(
                grandparent.operatorToken.kind,
              )
            )
            || (
              ts.isDeleteExpression(grandparent)
              && grandparent.expression === parent
            )
            || (
              (
                ts.isPrefixUnaryExpression(grandparent)
                || ts.isPostfixUnaryExpression(grandparent)
              )
              && grandparent.operand === parent
            )
            || (
              ts.isCallExpression(grandparent)
              && grandparent.expression === parent
              && propertyName !== 'constructor'
            )
          ) {
            safe = false;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(lexicalMetadata.sourceFile);
  return safe;
}

function expressionIsGlobalAlias(metadata, node) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    if (globalObjectNames.has(expression.text)) {
      return !resolveLexicalBinding(
        metadata,
        expression,
        expression.text,
      ).bound;
    }
    return resolveGlobalAlias(metadata, expression, expression.text);
  }
  if (
    (
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
    && globalObjectNames.has(
      memberPropertyName(expression, metadata),
    )
  ) {
    return expressionIsGlobalAlias(
      metadata,
      expression.expression,
    );
  }
  return false;
}

function resolveCodeGenerationAlias(metadata, node, name) {
  const binding = resolveLexicalBinding(metadata, node, name);
  return Boolean(
    binding.scope
    && metadata.codeGenerationAliasesByScope
      .get(binding.scope)
      ?.has(name),
  );
}

function expressionHasProvenSafeOwnConstructor(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    );
    return Boolean(
      binding.scope
      && lexicalMetadata.safeConstructorReceiversByScope
        .get(binding.scope)
      ?.has(expression.text),
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return expressionHasProvenSafeOwnConstructor(
      expression.whenTrue,
      lexicalMetadata,
    ) && expressionHasProvenSafeOwnConstructor(
      expression.whenFalse,
      lexicalMetadata,
    );
  }
  if (
    ts.isCallExpression(expression)
    && expression.arguments.length === 1
    && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression)
    && expression.expression.expression.text === 'Object'
    && expression.expression.name.text === 'freeze'
    && !resolveLexicalBinding(
      lexicalMetadata,
      expression.expression.expression,
      'Object',
    ).bound
  ) {
    return expressionHasProvenSafeOwnConstructor(
      expression.arguments[0],
      lexicalMetadata,
    );
  }
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some((property) => {
    if (
      !(
        ts.isPropertyAssignment(property)
        || ts.isMethodDeclaration(property)
      )
      || staticPropertyNameValue(property.name, lexicalMetadata)
        !== 'constructor'
    ) {
      return false;
    }
    return ts.isMethodDeclaration(property)
      || ts.isArrowFunction(property.initializer)
      || ts.isFunctionExpression(property.initializer);
  });
}

function expressionIsUnshadowedReflectNamespace(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (!ts.isIdentifier(expression)) return false;
  if (expression.text === 'Reflect') {
    return !resolveLexicalBinding(
      lexicalMetadata,
      expression,
      'Reflect',
    ).bound;
  }
  const binding = resolveLexicalBinding(
    lexicalMetadata,
    expression,
    expression.text,
  );
  return Boolean(
    binding.scope
    && lexicalMetadata.reflectNamespacesByScope
      .get(binding.scope)
      ?.has(expression.text),
  );
}

function resolveReflectFunctionAlias(metadata, node, name) {
  const binding = resolveLexicalBinding(metadata, node, name);
  return binding.scope
    ? metadata.reflectFunctionsByScope.get(binding.scope)?.get(name)
    : undefined;
}

function reflectFunctionKind(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return resolveReflectFunctionAlias(
      lexicalMetadata,
      expression,
      expression.text,
    );
  }
  if (
    !(
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
    || !expressionIsUnshadowedReflectNamespace(
      expression.expression,
      lexicalMetadata,
    )
  ) {
    return undefined;
  }
  const propertyName = memberPropertyName(
    expression,
    lexicalMetadata,
  );
  return reflectCodeGenerationMemberNames.has(propertyName)
    ? propertyName
    : undefined;
}

function isUnshadowedReflectMember(
  expression,
  memberNames,
  lexicalMetadata,
) {
  return memberNames.has(
    reflectFunctionKind(expression, lexicalMetadata),
  );
}

function isUnshadowedObjectStaticCall(
  node,
  methodName,
  lexicalMetadata,
) {
  const expression = unwrapExpression(node);
  if (
    !ts.isCallExpression(expression)
    || !(
      ts.isPropertyAccessExpression(expression.expression)
      || ts.isElementAccessExpression(expression.expression)
    )
    || memberPropertyName(
      expression.expression,
      lexicalMetadata,
    ) !== methodName
  ) {
    return false;
  }
  const namespace = unwrapExpression(expression.expression.expression);
  return ts.isIdentifier(namespace)
    && namespace.text === 'Object'
    && !resolveLexicalBinding(
      lexicalMetadata,
      namespace,
      'Object',
    ).bound;
}

function expressionIsKnownFunctionValue(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (
    isFunctionLikeScope(expression)
    || ts.isClassExpression(expression)
    || ts.isClassDeclaration(expression)
  ) {
    return true;
  }
  if (!ts.isIdentifier(expression)) return false;
  const binding = resolveLexicalBinding(
    lexicalMetadata,
    expression,
    expression.text,
  );
  const initializer = binding.initializer
    ? unwrapExpression(binding.initializer)
    : undefined;
  return Boolean(
    binding.functionDeclaration
    || binding.classDeclaration
    || initializer
      && (
        isFunctionLikeScope(initializer)
        || ts.isClassExpression(initializer)
      ),
  );
}

function expressionIsKnownFunctionPrototype(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (
    isUnshadowedObjectStaticCall(
      expression,
      'getPrototypeOf',
      lexicalMetadata,
    )
  ) {
    return Boolean(
      expression.arguments[0]
      && expressionIsKnownFunctionValue(
        expression.arguments[0],
        lexicalMetadata,
      ),
    );
  }
  return Boolean(
    (
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
    && memberPropertyName(expression, lexicalMetadata) === 'prototype'
    && expressionIsCodeGenerationCallable(
      expression.expression,
      lexicalMetadata,
    ),
  );
}

function expressionIsFunctionConstructorDescriptor(
  node,
  lexicalMetadata,
  visited = new Set(),
) {
  const expression = unwrapExpression(node);
  if (visited.has(expression)) return false;
  visited.add(expression);
  if (ts.isIdentifier(expression)) {
    const binding = resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    );
    return Boolean(
      binding.initializer
      && expressionIsFunctionConstructorDescriptor(
        binding.initializer,
        lexicalMetadata,
        visited,
      ),
    );
  }
  if (
    isUnshadowedObjectStaticCall(
      expression,
      'getOwnPropertyDescriptor',
      lexicalMetadata,
    )
    && expression.arguments.length >= 2
    && expressionIsKnownFunctionPrototype(
      expression.arguments[0],
      lexicalMetadata,
    )
  ) {
    const propertyName = staticStringExpressionValue(
      expression.arguments[1],
      lexicalMetadata,
    );
    return propertyName === undefined || propertyName === 'constructor';
  }
  if (
    (
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
    && isUnshadowedObjectStaticCall(
      expression.expression,
      'getOwnPropertyDescriptors',
      lexicalMetadata,
    )
    && expressionIsKnownFunctionPrototype(
      unwrapExpression(expression.expression).arguments[0],
      lexicalMetadata,
    )
  ) {
    const propertyName = memberPropertyName(expression, lexicalMetadata);
    return propertyName === undefined || propertyName === 'constructor';
  }
  return false;
}

function expressionIsCodeGenerationCallable(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    if (hiddenCodeGenerationNames.has(expression.text)) {
      return !resolveLexicalBinding(
        lexicalMetadata,
        expression,
        expression.text,
      ).bound;
    }
    return resolveCodeGenerationAlias(
      lexicalMetadata,
      expression,
      expression.text,
    );
  }
  if (
    ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression)
  ) {
    const propertyName = memberPropertyName(
      expression,
      lexicalMetadata,
    );
    if (propertyName === 'constructor') {
      return !expressionHasProvenSafeOwnConstructor(
        expression.expression,
        lexicalMetadata,
      );
    }
    if (
      hiddenCodeGenerationNames.has(propertyName)
      && expressionIsGlobalAlias(
        lexicalMetadata,
        expression.expression,
      )
    ) {
      return true;
    }
    if (
      propertyName === 'value'
      && expressionIsFunctionConstructorDescriptor(
        expression.expression,
        lexicalMetadata,
      )
    ) {
      return true;
    }
    return (
      /^(?:apply|bind|call)$/u.test(propertyName ?? '')
      && expressionIsCodeGenerationCallable(
        expression.expression,
        lexicalMetadata,
      )
    );
  }
  if (
    ts.isCallExpression(expression)
    && expression.arguments.length >= 2
    && isUnshadowedReflectMember(
      expression.expression,
      reflectGetNames,
      lexicalMetadata,
    )
  ) {
    const propertyName = staticStringExpressionValue(
      expression.arguments[1],
      lexicalMetadata,
    );
    return (
      propertyName === undefined
      || propertyName === 'constructor'
    )
      && !expressionHasProvenSafeOwnConstructor(
        expression.arguments[0],
        lexicalMetadata,
      );
  }
  if (
    ts.isCallExpression(expression)
    && (
      isUnshadowedReflectMember(
        expression.expression,
        reflectCodeGenerationInvocationNames,
        lexicalMetadata,
      )
      ? expression.arguments.slice(0, 1)
      : expression.arguments
    ).some((argument) => expressionIsCodeGenerationCallable(
      argument,
      lexicalMetadata,
    ))
  ) {
    return true;
  }
  if (ts.isConditionalExpression(expression)) {
    return expressionIsCodeGenerationCallable(
      expression.whenTrue,
      lexicalMetadata,
    ) || expressionIsCodeGenerationCallable(
      expression.whenFalse,
      lexicalMetadata,
    );
  }
  if (
    ts.isBinaryExpression(expression)
    && (
      expression.operatorToken.kind === ts.SyntaxKind.CommaToken
      || expression.operatorToken.kind
        === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind
        === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind
        === ts.SyntaxKind.QuestionQuestionToken
    )
  ) {
    return expressionIsCodeGenerationCallable(
      expression.left,
      lexicalMetadata,
    ) || expressionIsCodeGenerationCallable(
      expression.right,
      lexicalMetadata,
    );
  }
  return false;
}

function callUsesReflectCodeGenerationComposition(
  node,
  lexicalMetadata,
) {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrapExpression(node.expression);
  if (
    (
      ts.isPropertyAccessExpression(callee)
      || ts.isElementAccessExpression(callee)
    )
    && /^(?:apply|bind|call)$/u.test(
      memberPropertyName(callee, lexicalMetadata) ?? '',
    )
    && reflectFunctionKind(
      callee.expression,
      lexicalMetadata,
    ) === 'get'
  ) {
    return true;
  }
  return reflectFunctionKind(callee, lexicalMetadata) === 'apply'
    && node.arguments.length >= 1
    && reflectFunctionKind(
      node.arguments[0],
      lexicalMetadata,
    ) === 'get';
}

function transparentExpressionParent(node) {
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
  return { current, parent };
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  ));
}

function isExportedVariableInitializer(current, parent) {
  return Boolean(
    parent
    && ts.isVariableDeclaration(parent)
    && parent.initializer === current
    && ts.isVariableDeclarationList(parent.parent)
    && ts.isVariableStatement(parent.parent.parent)
    && hasExportModifier(parent.parent.parent),
  );
}

function valueIsExportedVariableInitializer(node) {
  const { current, parent } = transparentExpressionParent(node);
  return isExportedVariableInitializer(current, parent);
}

function valueEscapeKind(node, isSensitiveValue) {
  if (!isSensitiveValue(node)) return undefined;
  const { current, parent } = transparentExpressionParent(node);
  if (!parent) return undefined;
  if (isExportedVariableInitializer(current, parent)) return 'export';
  if (
    (ts.isPropertyAssignment(parent) && parent.initializer === current)
    || ts.isShorthandPropertyAssignment(parent)
    || ts.isArrayLiteralExpression(parent)
    || (ts.isReturnStatement(parent) && parent.expression === current)
    || (ts.isYieldExpression(parent) && parent.expression === current)
    || (
      ts.isArrowFunction(parent)
      && parent.body === current
      && !ts.isBlock(parent.body)
    )
    || (
      ts.isPropertyDeclaration(parent)
      && parent.initializer === current
    )
    || ts.isSpreadAssignment(parent)
    || ts.isSpreadElement(parent)
    || ts.isTemplateSpan(parent)
    || ts.isConditionalExpression(parent)
    || ts.isAwaitExpression(parent)
    || (
      ts.isThrowStatement(parent)
      && parent.expression === current
    )
    || (
      ts.isExportAssignment(parent)
      && parent.expression === current
    )
    || ts.isExportSpecifier(parent)
  ) {
    return 'opaque';
  }
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent))
    && parent.arguments?.includes(current)
  ) {
    return 'opaque-call';
  }
  if (ts.isBinaryExpression(parent)) {
    if (
      isAssignmentOperator(parent.operatorToken.kind)
      && parent.right === current
    ) {
      return !ts.isIdentifier(unwrapExpression(parent.left))
        ? 'opaque'
        : undefined;
    }
    return !isEqualityOperator(parent.operatorToken.kind)
      ? 'opaque'
      : undefined;
  }
  return undefined;
}

function codeGenerationValueEscapes(node, lexicalMetadata) {
  return valueEscapeKind(
    node,
    (candidate) => expressionIsCodeGenerationCallable(
      candidate,
      lexicalMetadata,
    ),
  ) !== undefined;
}

function memberPropertyName(node, lexicalMetadata) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    return lexicalMetadata
      ? staticStringExpressionValue(
        node.argumentExpression,
        lexicalMetadata,
      )
      : staticPropertyName(node.argumentExpression);
  }
  return undefined;
}

function globalMemberChainInfo(node, lexicalMetadata) {
  let current = node;
  let depth = 0;
  while (
    ts.isPropertyAccessExpression(current)
    || ts.isElementAccessExpression(current)
  ) {
    depth += 1;
    const propertyName = memberPropertyName(current, lexicalMetadata);
    const expression = unwrapExpression(current.expression);
    if (expressionIsGlobalAlias(lexicalMetadata, expression)) {
      return { depth, firstPropertyName: propertyName };
    }
    current = expression;
  }
  return undefined;
}

function expressionIsNativeNamespaceValue(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    );
    if (nativeNamespaceNames.has(expression.text) && !binding.bound) {
      return true;
    }
    return Boolean(
      binding.scope
      && lexicalMetadata.nativeNamespaceAliasesByScope
        .get(binding.scope)
        ?.has(expression.text),
    );
  }
  if (
    ts.isPropertyAccessExpression(expression)
    || ts.isElementAccessExpression(expression)
  ) {
    return expressionIsNativeNamespaceValue(
      expression.expression,
      lexicalMetadata,
    ) || nativeNamespaceNames.has(
      globalMemberChainInfo(
        expression,
        lexicalMetadata,
      )?.firstPropertyName,
    );
  }
  return Boolean(
    ts.isCallExpression(expression)
    && reflectFunctionKind(
      expression.expression,
      lexicalMetadata,
    ) === 'get'
    && expression.arguments.length >= 2
    && expressionIsGlobalAlias(
      lexicalMetadata,
      expression.arguments[0],
    )
    && nativeNamespaceNames.has(
      staticStringExpressionValue(
        expression.arguments[1],
        lexicalMetadata,
      ),
    ),
  );
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

function globalObjectValueEscapes(node, lexicalMetadata) {
  return valueEscapeKind(
    node,
    (candidate) => expressionIsGlobalAlias(
      lexicalMetadata,
      candidate,
    ),
  ) !== undefined;
}

function globalObjectEscapeKind(node, lexicalMetadata) {
  return valueEscapeKind(
    node,
    (candidate) => expressionIsGlobalAlias(
      lexicalMetadata,
      candidate,
    ),
  );
}

function isGlobalObjectExpression(node, lexicalMetadata) {
  return expressionIsGlobalAlias(lexicalMetadata, node);
}

function isReflectGlobalAccess(node, lexicalMetadata) {
  if (
    !ts.isCallExpression(node)
    || node.arguments.length < 2
    || reflectFunctionKind(node.expression, lexicalMetadata) !== 'get'
    || !isGlobalObjectExpression(node.arguments[0], lexicalMetadata)
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

function isWithinReflectGlobalAccess(node, lexicalMetadata) {
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
    && isReflectGlobalAccess(parent, lexicalMetadata),
  );
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

function expressionIsCreateRequireFunction(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    );
    return Boolean(
      binding.scope
      && lexicalMetadata.createRequireFunctionsByScope
        .get(binding.scope)
        ?.has(expression.text),
    );
  }
  return Boolean(
    (
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
    && memberPropertyName(expression, lexicalMetadata)
      === 'createRequire'
    && expressionIsNodeModuleNamespace(
      expression.expression,
      lexicalMetadata,
    ),
  );
}

function expressionIsNodeModuleNamespace(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (!ts.isIdentifier(expression)) return false;
  const binding = resolveLexicalBinding(
    lexicalMetadata,
    expression,
    expression.text,
  );
  return Boolean(
    binding.scope
    && lexicalMetadata.nodeModuleNamespacesByScope
      .get(binding.scope)
      ?.has(expression.text),
  );
}

function expressionIsCommonJsModuleNamespace(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (!ts.isIdentifier(expression)) return false;
  if (expression.text === 'module') {
    return !resolveLexicalBinding(
      lexicalMetadata,
      expression,
      'module',
    ).bound;
  }
  const binding = resolveLexicalBinding(
    lexicalMetadata,
    expression,
    expression.text,
  );
  return Boolean(
    binding.scope
    && lexicalMetadata.commonJsModuleNamespacesByScope
      .get(binding.scope)
      ?.has(expression.text),
  );
}

function expressionIsModuleLoader(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    if (expression.text === 'require') {
      return !resolveLexicalBinding(
        lexicalMetadata,
        expression,
        'require',
      ).bound;
    }
    const binding = resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    );
    return Boolean(
      binding.scope
      && lexicalMetadata.moduleLoaderAliasesByScope
        .get(binding.scope)
        ?.has(expression.text),
    );
  }
  if (
    (
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
  ) {
    const propertyName = memberPropertyName(
      expression,
      lexicalMetadata,
    );
    if (
      propertyName === 'require'
      && expressionIsCommonJsModuleNamespace(
        expression.expression,
        lexicalMetadata,
      )
    ) {
      return true;
    }
    if (
      /^(?:apply|bind|call)$/u.test(propertyName ?? '')
      && expressionIsModuleLoader(
        expression.expression,
        lexicalMetadata,
      )
    ) {
      return true;
    }
  }
  if (ts.isConditionalExpression(expression)) {
    return expressionIsModuleLoader(
      expression.whenTrue,
      lexicalMetadata,
    ) || expressionIsModuleLoader(
      expression.whenFalse,
      lexicalMetadata,
    );
  }
  if (
    ts.isBinaryExpression(expression)
    && (
      expression.operatorToken.kind === ts.SyntaxKind.CommaToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind
        === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind
        === ts.SyntaxKind.QuestionQuestionToken
    )
  ) {
    return expressionIsModuleLoader(
      expression.left,
      lexicalMetadata,
    ) || expressionIsModuleLoader(
      expression.right,
      lexicalMetadata,
    );
  }
  if (!ts.isCallExpression(expression)) return false;
  if (
    expressionIsCreateRequireFunction(
      expression.expression,
      lexicalMetadata,
    )
  ) {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'bind'
    && expressionIsModuleLoader(
      expression.expression.expression,
      lexicalMetadata,
    )
  ) {
    return true;
  }
  return reflectFunctionKind(
    expression.expression,
    lexicalMetadata,
  ) === 'apply'
    && expression.arguments.length >= 1
    && expressionIsModuleLoader(
      expression.arguments[0],
      lexicalMetadata,
    );
}

function isDynamicModuleLoadCall(node, lexicalMetadata) {
  if (!ts.isCallExpression(node)) return false;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (
    expressionIsModuleLoader(node.expression, lexicalMetadata)
    || expressionIsModuleLoader(node, lexicalMetadata)
  ) {
    return true;
  }
  const callee = unwrapExpression(node.expression);
  return (
    (
      ts.isPropertyAccessExpression(callee)
      || ts.isElementAccessExpression(callee)
    )
    && memberPropertyName(callee, lexicalMetadata) === 'resolve'
    && expressionIsModuleLoader(callee.expression, lexicalMetadata)
  );
}

function expressionIsTransferSensitiveCapability(
  node,
  lexicalMetadata,
) {
  return reflectFunctionKind(node, lexicalMetadata) !== undefined
    || expressionIsUnshadowedReflectNamespace(
      node,
      lexicalMetadata,
    )
    || expressionIsModuleLoader(node, lexicalMetadata)
    || expressionIsCreateRequireFunction(node, lexicalMetadata)
    || expressionIsNodeModuleNamespace(node, lexicalMetadata)
    || expressionIsCommonJsModuleNamespace(
      node,
      lexicalMetadata,
    );
}

function expressionIsBuildPathAnchor(node, lexicalMetadata) {
  return buildPathExpressionValue(node, lexicalMetadata) !== undefined
    || buildUrlBaseDirectoryValue(node, lexicalMetadata) !== undefined;
}

function expressionContainsBuildPathAnchor(
  node,
  lexicalMetadata,
  visited = new Set(),
) {
  const expression = unwrapExpression(node);
  if (visited.has(expression)) return false;
  visited.add(expression);
  if (expressionIsBuildPathAnchor(expression, lexicalMetadata)) {
    return true;
  }
  if (ts.isAwaitExpression(expression)) {
    return expressionContainsBuildPathAnchor(
      expression.expression,
      lexicalMetadata,
      visited,
    );
  }
  if (isFunctionLikeScope(expression)) {
    return functionReturnsBuildPathAnchor(
      expression,
      lexicalMetadata,
      visited,
    );
  }
  if (
    ts.isClassDeclaration(expression)
    || ts.isClassExpression(expression)
  ) {
    return expression.members.some((member) => {
      if (
        ts.isPropertyDeclaration(member)
        && member.initializer
      ) {
        return expressionContainsBuildPathAnchor(
          member.initializer,
          lexicalMetadata,
          visited,
        );
      }
      return isFunctionLikeScope(member)
        && (
          functionReturnsBuildPathAnchor(
            member,
            lexicalMetadata,
            visited,
          )
          || functionStoresBuildPathAnchor(
            member,
            lexicalMetadata,
            visited,
          )
        );
    });
  }
  if (ts.isIdentifier(expression)) {
    const binding = resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    );
    if (
      binding.functionDeclaration
      && !visited.has(binding.functionDeclaration)
    ) {
      visited.add(binding.functionDeclaration);
      if (
        functionReturnsBuildPathAnchor(
          binding.functionDeclaration,
          lexicalMetadata,
          visited,
        )
      ) {
        return true;
      }
    }
    if (
      binding.classDeclaration
      && !visited.has(binding.classDeclaration)
    ) {
      return expressionContainsBuildPathAnchor(
        binding.classDeclaration,
        lexicalMetadata,
        visited,
      );
    }
    return Boolean(
      binding.initializer
      && expressionContainsBuildPathAnchor(
        binding.initializer,
        lexicalMetadata,
        visited,
      ),
    );
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return expressionContainsBuildPathAnchor(
          property.initializer,
          lexicalMetadata,
          visited,
        );
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return expressionContainsBuildPathAnchor(
          property.name,
          lexicalMetadata,
          visited,
        );
      }
      if (ts.isSpreadAssignment(property)) {
        return expressionContainsBuildPathAnchor(
          property.expression,
          lexicalMetadata,
          visited,
        );
      }
      if (isFunctionLikeScope(property)) {
        return functionReturnsBuildPathAnchor(
          property,
          lexicalMetadata,
          visited,
        );
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some(
      (element) => !ts.isOmittedExpression(element)
        && expressionContainsBuildPathAnchor(
          element,
          lexicalMetadata,
          visited,
        ),
    );
  }
  if (
    ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression)
    && expression.expression.expression.text === 'Object'
    && expression.expression.name.text === 'freeze'
    && !resolveLexicalBinding(
      lexicalMetadata,
      expression.expression.expression,
      'Object',
    ).bound
  ) {
    return Boolean(
      expression.arguments[0]
      && expressionContainsBuildPathAnchor(
        expression.arguments[0],
        lexicalMetadata,
        visited,
      ),
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return expressionContainsBuildPathAnchor(
      expression.whenTrue,
      lexicalMetadata,
      visited,
    ) || expressionContainsBuildPathAnchor(
      expression.whenFalse,
      lexicalMetadata,
      visited,
    );
  }
  return false;
}

function functionReturnsBuildPathAnchor(
  functionNode,
  lexicalMetadata,
  visited = new Set(),
) {
  if (!functionNode.body) return false;
  if (
    ts.isArrowFunction(functionNode)
    && !ts.isBlock(functionNode.body)
  ) {
    return expressionContainsBuildPathAnchor(
      functionNode.body,
      lexicalMetadata,
      visited,
    );
  }
  let returnsAnchor = false;
  function visit(node) {
    if (returnsAnchor) return;
    if (node !== functionNode.body && isFunctionLikeScope(node)) return;
    if (
      ts.isReturnStatement(node)
      && node.expression
      && expressionContainsBuildPathAnchor(
        node.expression,
        lexicalMetadata,
        visited,
      )
    ) {
      returnsAnchor = true;
      return;
    }
    if (
      ts.isYieldExpression(node)
      && node.expression
      && expressionContainsBuildPathAnchor(
        node.expression,
        lexicalMetadata,
        visited,
      )
    ) {
      returnsAnchor = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(functionNode.body);
  return returnsAnchor;
}

function functionStoresBuildPathAnchor(
  functionNode,
  lexicalMetadata,
  visited = new Set(),
) {
  if (!functionNode.body || !ts.isBlock(functionNode.body)) return false;
  let storesAnchor = false;
  function visit(node) {
    if (storesAnchor) return;
    if (node !== functionNode.body && isFunctionLikeScope(node)) return;
    if (
      ts.isBinaryExpression(node)
      && isAssignmentOperator(node.operatorToken.kind)
      && (
        ts.isPropertyAccessExpression(unwrapExpression(node.left))
        || ts.isElementAccessExpression(unwrapExpression(node.left))
      )
      && unwrapExpression(
        unwrapExpression(node.left).expression,
      ).kind === ts.SyntaxKind.ThisKeyword
      && expressionContainsBuildPathAnchor(
        node.right,
        lexicalMetadata,
        visited,
      )
    ) {
      storesAnchor = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(functionNode.body);
  return storesAnchor;
}

function isBrowserSpecificIdentifierName(name) {
  const words = name
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .split(/[_$\s]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  return words.some((word) => {
    if (word.startsWith('firefox') || word.startsWith('isfirefox')) {
      return true;
    }
    if (word.startsWith('ischrome')) return true;
    return word.startsWith('chrome')
      && !word.startsWith('chromebook')
      && !word.startsWith('chromium');
  });
}

function isCommonJsExportTarget(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (
    ts.isIdentifier(expression)
    && expression.text === 'exports'
    && !resolveLexicalBinding(
      lexicalMetadata,
      expression,
      'exports',
    ).bound
  ) {
    return true;
  }
  if (
    !(
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
  ) {
    return false;
  }
  if (
    memberPropertyName(expression, lexicalMetadata) === 'exports'
    && expressionIsCommonJsModuleNamespace(
      expression.expression,
      lexicalMetadata,
    )
  ) {
    return true;
  }
  return isCommonJsExportTarget(
    expression.expression,
    lexicalMetadata,
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

function staticStringExpressionValue(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  const literalValue = stringLiteralValue(expression);
  if (literalValue !== undefined) return literalValue;
  if (ts.isIdentifier(expression)) {
    return resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    ).constantValue;
  }
  if (
    ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'sep'
    && expressionIsNodePathNamespace(
      expression.expression,
      lexicalMetadata,
    )
  ) {
    return '/';
  }
  if (
    ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringExpressionValue(
      expression.left,
      lexicalMetadata,
    );
    const right = staticStringExpressionValue(
      expression.right,
      lexicalMetadata,
    );
    return left !== undefined && right !== undefined
      ? `${left}${right}`
      : undefined;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const substitution = staticStringExpressionValue(
        span.expression,
        lexicalMetadata,
      );
      if (substitution === undefined) return undefined;
      value += substitution + span.literal.text;
    }
    return value;
  }
  return undefined;
}

function staticPropertyNameValue(node, lexicalMetadata) {
  if (ts.isComputedPropertyName(node)) {
    return staticStringExpressionValue(
      node.expression,
      lexicalMetadata,
    );
  }
  return staticPropertyName(node);
}

function importMetaDirectoryAnchor(node, relativePath) {
  const expression = unwrapExpression(node);
  if (
    !ts.isPropertyAccessExpression(expression)
    || expression.name.text !== 'dirname'
    || !ts.isMetaProperty(expression.expression)
    || expression.expression.keywordToken !== ts.SyntaxKind.ImportKeyword
  ) {
    return undefined;
  }
  return path.posix.dirname(relativePath);
}

function expressionIsNodePathNamespace(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (
    ts.isPropertyAccessExpression(expression)
    && (
      expression.name.text === 'posix'
      || expression.name.text === 'win32'
    )
  ) {
    return expressionIsNodePathNamespace(
      expression.expression,
      lexicalMetadata,
    );
  }
  if (!ts.isIdentifier(expression)) return false;
  const binding = resolveLexicalBinding(
    lexicalMetadata,
    expression,
    expression.text,
  );
  return Boolean(
    binding.scope
    && lexicalMetadata.pathNamespacesByScope
      .get(binding.scope)
      ?.has(expression.text),
  );
}

function nodePathFunctionKind(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    );
    return binding.scope
      ? lexicalMetadata.pathFunctionsByScope
        .get(binding.scope)
        ?.get(expression.text)
      : undefined;
  }
  if (
    ts.isPropertyAccessExpression(expression)
    && expressionIsNodePathNamespace(
      expression.expression,
      lexicalMetadata,
    )
    && (
      expression.name.text === 'join'
      || expression.name.text === 'resolve'
    )
  ) {
    return expression.name.text;
  }
  return undefined;
}

function expressionIsFileUrlToPathFunction(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (!ts.isIdentifier(expression)) return false;
  const binding = resolveLexicalBinding(
    lexicalMetadata,
    expression,
    expression.text,
  );
  return Boolean(
    binding.scope
    && lexicalMetadata.fileUrlToPathFunctionsByScope
      .get(binding.scope)
      ?.has(expression.text),
  );
}

function normalizeBuildPathSegment(value) {
  return value.replace(/\\/gu, '/');
}

function mergeBuildPathAnchorValues(existing, candidate) {
  if (existing === undefined) return candidate;
  if (existing === candidate) return existing;
  const existingParts = path.posix.normalize(existing)
    .split('/')
    .filter((part) => part && part !== '.');
  const candidateParts = path.posix.normalize(candidate)
    .split('/')
    .filter((part) => part && part !== '.');
  const common = [];
  const length = Math.min(existingParts.length, candidateParts.length);
  for (let index = 0; index < length; index += 1) {
    if (existingParts[index] !== candidateParts[index]) break;
    common.push(existingParts[index]);
  }
  return common.length > 0 ? common.join('/') : '.';
}

function simpleFunctionReturnExpression(functionNode) {
  if (!functionNode.body) return undefined;
  if (
    ts.isArrowFunction(functionNode)
    && !ts.isBlock(functionNode.body)
  ) {
    return functionNode.body;
  }
  if (
    ts.isBlock(functionNode.body)
  ) {
    const returnStatements = functionNode.body.statements.filter(
      ts.isReturnStatement,
    );
    if (
      returnStatements.length === 1
      && returnStatements[0].expression
    ) {
      return returnStatements[0].expression;
    }
  }
  return undefined;
}

function localZeroArgumentFunctionReturn(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (
    !ts.isCallExpression(expression)
    || expression.arguments.length !== 0
    || !ts.isIdentifier(unwrapExpression(expression.expression))
  ) {
    return undefined;
  }
  const callee = unwrapExpression(expression.expression);
  const binding = resolveLexicalBinding(
    lexicalMetadata,
    callee,
    callee.text,
  );
  const functionNode = binding.functionDeclaration
    ?? (
      binding.initializer
      && (
        ts.isArrowFunction(unwrapExpression(binding.initializer))
        || ts.isFunctionExpression(unwrapExpression(binding.initializer))
      )
        ? unwrapExpression(binding.initializer)
        : undefined
    );
  if (!functionNode || functionNode.parameters.length !== 0) {
    return undefined;
  }
  const returnExpression = simpleFunctionReturnExpression(functionNode);
  return returnExpression
    ? {
      expression: returnExpression,
      functionNode,
    }
    : undefined;
}

function stableContainerExpression(
  node,
  lexicalMetadata,
  visitedBindings = new Set(),
) {
  let expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    );
    if (
      binding.initializer
      && !visitedBindings.has(binding.initializer)
    ) {
      visitedBindings.add(binding.initializer);
      return stableContainerExpression(
        binding.initializer,
        lexicalMetadata,
        visitedBindings,
      );
    }
  }
  const localReturn = localZeroArgumentFunctionReturn(
    expression,
    lexicalMetadata,
  );
  if (localReturn) expression = unwrapExpression(localReturn.expression);
  if (
    ts.isCallExpression(expression)
    && expression.arguments.length >= 1
    && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression)
    && expression.expression.expression.text === 'Object'
    && expression.expression.name.text === 'freeze'
    && !resolveLexicalBinding(
      lexicalMetadata,
      expression.expression.expression,
      'Object',
    ).bound
  ) {
    return stableContainerExpression(
      expression.arguments[0],
      lexicalMetadata,
      visitedBindings,
    );
  }
  return expression;
}

function assignedContainerPropertyExpression(
  containerIdentifier,
  propertyName,
  lexicalMetadata,
) {
  const binding = resolveLexicalBinding(
    lexicalMetadata,
    containerIdentifier,
    containerIdentifier.text,
  );
  if (!binding.scope) return undefined;
  let assignedExpression;
  function visit(node) {
    if (assignedExpression) return;
    if (
      ts.isBinaryExpression(node)
      && isAssignmentOperator(node.operatorToken.kind)
      && (
        ts.isPropertyAccessExpression(unwrapExpression(node.left))
        || ts.isElementAccessExpression(unwrapExpression(node.left))
      )
    ) {
      const target = unwrapExpression(node.left);
      const base = unwrapExpression(target.expression);
      if (
        ts.isIdentifier(base)
        && base.text === containerIdentifier.text
        && memberPropertyName(target, lexicalMetadata) === propertyName
        && resolveLexicalBinding(
          lexicalMetadata,
          base,
          base.text,
        ).scope === binding.scope
      ) {
        assignedExpression = node.right;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(lexicalMetadata.sourceFile);
  return assignedExpression;
}

function buildContainerPropertyExpression(
  containerNode,
  propertyName,
  lexicalMetadata,
  visitedContainers = new Set(),
) {
  const originalContainer = unwrapExpression(containerNode);
  if (visitedContainers.has(originalContainer)) return undefined;
  visitedContainers.add(originalContainer);
  const container = stableContainerExpression(
    originalContainer,
    lexicalMetadata,
  );
  if (ts.isObjectLiteralExpression(container)) {
    for (const property of [...container.properties].reverse()) {
      if (
        ts.isPropertyAssignment(property)
        && staticPropertyNameValue(property.name, lexicalMetadata)
          === propertyName
      ) {
        return property.initializer;
      }
      if (
        ts.isShorthandPropertyAssignment(property)
        && property.name.text === propertyName
      ) {
        return property.name;
      }
      if (ts.isSpreadAssignment(property)) {
        const spreadValue = buildContainerPropertyExpression(
          property.expression,
          propertyName,
          lexicalMetadata,
          visitedContainers,
        );
        if (spreadValue) return spreadValue;
      }
    }
  }
  if (ts.isArrayLiteralExpression(container) && /^\d+$/u.test(propertyName)) {
    const element = container.elements[Number(propertyName)];
    return element && !ts.isOmittedExpression(element)
      ? element
      : undefined;
  }
  if (ts.isIdentifier(originalContainer)) {
    return assignedContainerPropertyExpression(
      originalContainer,
      propertyName,
      lexicalMetadata,
    );
  }
  return undefined;
}

function buildContainerElementExpression(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (
    !(
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
  ) {
    return undefined;
  }
  const propertyName = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : (
      ts.isNumericLiteral(expression.argumentExpression)
        ? expression.argumentExpression.text
        : staticStringExpressionValue(
          expression.argumentExpression,
          lexicalMetadata,
        )
    );
  return propertyName === undefined
    ? undefined
    : buildContainerPropertyExpression(
      expression.expression,
      propertyName,
      lexicalMetadata,
    );
}

function buildPathExpressionValue(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  const importMetaAnchor = importMetaDirectoryAnchor(
    expression,
    lexicalMetadata.relativePath,
  );
  if (importMetaAnchor !== undefined) return importMetaAnchor;
  if (ts.isIdentifier(expression)) {
    return resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    ).pathAnchor;
  }
  if (
    (
      ts.isPropertyAccessExpression(expression)
      || ts.isElementAccessExpression(expression)
    )
    && memberPropertyName(expression, lexicalMetadata) === 'pathname'
  ) {
    const urlPath = buildUrlObjectPathValue(
      expression.expression,
      lexicalMetadata,
    );
    if (urlPath !== undefined) return urlPath;
  }
  const containerElement = buildContainerElementExpression(
    expression,
    lexicalMetadata,
  );
  if (containerElement) {
    return buildPathExpressionValue(
      containerElement,
      lexicalMetadata,
    );
  }
  const localReturn = localZeroArgumentFunctionReturn(
    expression,
    lexicalMetadata,
  );
  if (localReturn) {
    const activeFunctions =
      lexicalMetadata.activeBuildPathFunctions ??= new Set();
    if (activeFunctions.has(localReturn.functionNode)) return undefined;
    activeFunctions.add(localReturn.functionNode);
    try {
      return buildPathExpressionValue(
        localReturn.expression,
        lexicalMetadata,
      );
    } finally {
      activeFunctions.delete(localReturn.functionNode);
    }
  }
  if (
    ts.isCallExpression(expression)
    && expression.arguments.length >= 1
    && expressionIsFileUrlToPathFunction(
      expression.expression,
      lexicalMetadata,
    )
  ) {
    return buildUrlObjectPathValue(
      expression.arguments[0],
      lexicalMetadata,
    );
  }
  if (!ts.isCallExpression(expression) || expression.arguments.length < 1) {
    return undefined;
  }
  if (
    nodePathFunctionKind(expression.expression, lexicalMetadata)
    === undefined
  ) {
    return undefined;
  }

  const anchor = buildPathExpressionValue(
    expression.arguments[0],
    lexicalMetadata,
  );
  if (anchor === undefined) return undefined;
  const segments = [];
  for (const argument of expression.arguments.slice(1)) {
    const value = staticStringExpressionValue(argument, lexicalMetadata);
    if (value === undefined) return undefined;
    segments.push(normalizeBuildPathSegment(value));
  }
  return path.posix.normalize(path.posix.join(anchor, ...segments));
}

function buildPathExpressionHasUnknownSegment(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (
    !ts.isCallExpression(expression)
    || expression.arguments.length < 2
    || nodePathFunctionKind(
      expression.expression,
      lexicalMetadata,
    ) === undefined
    || buildPathExpressionValue(
      expression.arguments[0],
      lexicalMetadata,
    ) === undefined
  ) {
    return false;
  }
  return expression.arguments.slice(1).some(
    (argument) => staticStringExpressionValue(
      argument,
      lexicalMetadata,
    ) === undefined,
  );
}

function buildPathExpressionHasUnknownComposition(
  node,
  lexicalMetadata,
) {
  const expression = unwrapExpression(node);
  if (
    ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const operands = [];
    function collectOperands(candidate) {
      const value = unwrapExpression(candidate);
      if (
        ts.isBinaryExpression(value)
        && value.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        collectOperands(value.left);
        collectOperands(value.right);
        return;
      }
      operands.push(value);
    }
    collectOperands(expression);
    const hasAnchor = operands.some(
      (operand) => expressionIsBuildPathAnchor(
        operand,
        lexicalMetadata,
      ),
    );
    return hasAnchor && operands.some(
      (operand) => !expressionIsBuildPathAnchor(
        operand,
        lexicalMetadata,
      ) && staticStringExpressionValue(
        operand,
        lexicalMetadata,
      ) === undefined,
    );
  }
  if (
    ts.isCallExpression(expression)
    && (
      ts.isPropertyAccessExpression(expression.expression)
      || ts.isElementAccessExpression(expression.expression)
    )
    && memberPropertyName(
      expression.expression,
      lexicalMetadata,
    ) === 'concat'
    && expressionIsBuildPathAnchor(
      expression.expression.expression,
      lexicalMetadata,
    )
  ) {
    return expression.arguments.some(
      (argument) => staticStringExpressionValue(
        argument,
        lexicalMetadata,
      ) === undefined,
    );
  }
  return false;
}

function buildTemplatePathExpressionValue(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (!ts.isTemplateExpression(expression)) return undefined;
  let value = normalizeBuildPathSegment(expression.head.text);
  let anchored = false;
  for (const span of expression.templateSpans) {
    const anchor = buildPathExpressionValue(
      span.expression,
      lexicalMetadata,
    );
    const substitution = anchor ?? staticStringExpressionValue(
      span.expression,
      lexicalMetadata,
    );
    if (substitution === undefined) return undefined;
    if (anchor !== undefined) anchored = true;
    value += normalizeBuildPathSegment(substitution);
    value += normalizeBuildPathSegment(span.literal.text);
  }
  if (anchored) value = value.replace(/^\/+/u, '');
  return path.posix.normalize(value);
}

function buildPathTargetsRootSource(value) {
  const normalized = path.posix.normalize(
    normalizeBuildPathSegment(value),
  );
  return normalized === 'src' || normalized.startsWith('src/');
}

function importMetaUrlBaseDirectory(node, relativePath) {
  const expression = unwrapExpression(node);
  if (
    !ts.isPropertyAccessExpression(expression)
    || expression.name.text !== 'url'
    || !ts.isMetaProperty(expression.expression)
    || expression.expression.keywordToken !== ts.SyntaxKind.ImportKeyword
  ) {
    return undefined;
  }
  return path.posix.dirname(relativePath);
}

function buildUrlBaseDirectoryValue(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  const directBase = importMetaUrlBaseDirectory(
    expression,
    lexicalMetadata.relativePath,
  );
  if (directBase !== undefined) return directBase;
  if (ts.isIdentifier(expression)) {
    const binding = resolveLexicalBinding(
      lexicalMetadata,
      expression,
      expression.text,
    );
    return binding.scope
      ? lexicalMetadata.urlBaseDirectoriesByScope
        .get(binding.scope)
        ?.get(expression.text)
      : undefined;
  }
  const containerElement = buildContainerElementExpression(
    expression,
    lexicalMetadata,
  );
  if (containerElement) {
    return buildUrlBaseDirectoryValue(
      containerElement,
      lexicalMetadata,
    );
  }
  const localReturn = localZeroArgumentFunctionReturn(
    expression,
    lexicalMetadata,
  );
  if (localReturn) {
    const activeFunctions =
      lexicalMetadata.activeBuildUrlFunctions ??= new Set();
    if (activeFunctions.has(localReturn.functionNode)) return undefined;
    activeFunctions.add(localReturn.functionNode);
    try {
      return buildUrlBaseDirectoryValue(
        localReturn.expression,
        lexicalMetadata,
      );
    } finally {
      activeFunctions.delete(localReturn.functionNode);
    }
  }
  if (!ts.isNewExpression(expression)) return undefined;
  const target = buildUrlExpressionValue(expression, lexicalMetadata);
  if (target === undefined) return undefined;
  const rawValue = staticStringExpressionValue(
    expression.arguments[0],
    lexicalMetadata,
  );
  if (
    rawValue !== undefined
    && (
      /\/$/u.test(normalizeBuildPathSegment(rawValue))
      || /(?:^|\/)\.{1,2}$/u.test(
        normalizeBuildPathSegment(rawValue),
      )
    )
  ) {
    return target;
  }
  return path.posix.dirname(target);
}

function buildUrlExpressionValue(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (
    !ts.isNewExpression(expression)
    || expression.arguments?.length !== 2
    || !ts.isIdentifier(expression.expression)
    || expression.expression.text !== 'URL'
    || resolveLexicalBinding(
      lexicalMetadata,
      expression.expression,
      'URL',
    ).bound
  ) {
    return undefined;
  }
  const baseDirectory = buildUrlBaseDirectoryValue(
    expression.arguments[1],
    lexicalMetadata,
  );
  if (baseDirectory === undefined) return undefined;
  const value = staticStringExpressionValue(
    expression.arguments[0],
    lexicalMetadata,
  );
  if (value === undefined || /^[a-z][a-z\d+.-]*:/iu.test(value)) {
    return undefined;
  }
  return path.posix.normalize(path.posix.join(
    baseDirectory,
    normalizeBuildPathSegment(value),
  ));
}

function buildUrlObjectPathValue(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  const activeNodes =
    lexicalMetadata.activeBuildUrlObjectNodes ??= new Set();
  if (activeNodes.has(expression)) return undefined;
  activeNodes.add(expression);
  try {
    if (ts.isNewExpression(expression)) {
      return buildUrlExpressionValue(expression, lexicalMetadata);
    }
    if (ts.isIdentifier(expression)) {
      const binding = resolveLexicalBinding(
        lexicalMetadata,
        expression,
        expression.text,
      );
      if (binding.initializer) {
        return buildUrlObjectPathValue(
          binding.initializer,
          lexicalMetadata,
        );
      }
    }
    if (ts.isConditionalExpression(expression)) {
      return buildUrlObjectPathValue(
        expression.whenTrue,
        lexicalMetadata,
      ) ?? buildUrlObjectPathValue(
        expression.whenFalse,
        lexicalMetadata,
      );
    }
    const containerElement = buildContainerElementExpression(
      expression,
      lexicalMetadata,
    );
    if (containerElement) {
      return buildUrlObjectPathValue(
        containerElement,
        lexicalMetadata,
      );
    }
    const localReturn = localZeroArgumentFunctionReturn(
      expression,
      lexicalMetadata,
    );
    if (localReturn) {
      return buildUrlObjectPathValue(
        localReturn.expression,
        lexicalMetadata,
      );
    }
    return undefined;
  } finally {
    activeNodes.delete(expression);
  }
}

function buildUrlExpressionHasUnknownPath(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  return Boolean(
    ts.isNewExpression(expression)
    && expression.arguments?.length === 2
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'URL'
    && !resolveLexicalBinding(
      lexicalMetadata,
      expression.expression,
      'URL',
    ).bound
    && buildUrlBaseDirectoryValue(
      expression.arguments[1],
      lexicalMetadata,
    ) !== undefined
    && staticStringExpressionValue(
      expression.arguments[0],
      lexicalMetadata,
    ) === undefined,
  );
}

function staticBuildInputTargetsRootSource(
  value,
  relativePath,
) {
  const normalized = normalizeBuildPathSegment(value);
  if (/^\.?\/?src(?:\/|$)/u.test(normalized)) return true;
  if (!normalized.startsWith('.')) return false;
  return buildPathTargetsRootSource(path.posix.join(
    path.posix.dirname(relativePath),
    normalized,
  ));
}

function unresolvedTemplateTargetsRootSource(node, lexicalMetadata) {
  const expression = unwrapExpression(node);
  if (!ts.isTemplateExpression(expression)) return false;
  let skeleton = expression.head.text;
  let hasPathAnchor = false;
  let hasUnknownSubstitution = false;
  for (const span of expression.templateSpans) {
    if (
      buildPathExpressionValue(
        span.expression,
        lexicalMetadata,
      ) !== undefined
    ) {
      hasPathAnchor = true;
    }
    const substitution = staticStringExpressionValue(
      span.expression,
      lexicalMetadata,
    );
    if (substitution === undefined) {
      hasUnknownSubstitution = true;
      skeleton += '\0';
    } else {
      skeleton += substitution;
    }
    skeleton += span.literal.text;
  }
  if (hasPathAnchor && hasUnknownSubstitution) return true;
  const normalized = normalizeBuildPathSegment(skeleton);
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(normalized)) return false;
  return /(?:^|\/)src\//u.test(normalized);
}

function isWithinProvenNonRootPathCall(node, lexicalMetadata) {
  let current = node;
  let parent = current.parent;
  while (parent && !ts.isStatement(parent)) {
    if (
      ts.isCallExpression(parent)
      && parent.arguments.includes(current)
      && nodePathFunctionKind(
        parent.expression,
        lexicalMetadata,
      ) !== undefined
    ) {
      const resolvedPath = buildPathExpressionValue(
        parent,
        lexicalMetadata,
      );
      return resolvedPath !== undefined
        && !buildPathTargetsRootSource(resolvedPath);
    }
    if (
      ts.isNewExpression(parent)
      && parent.arguments?.includes(current)
    ) {
      const resolvedPath = buildUrlExpressionValue(
        parent,
        lexicalMetadata,
      );
      return resolvedPath !== undefined
        && !buildPathTargetsRootSource(resolvedPath);
    }
    current = parent;
    parent = current.parent;
  }
  return false;
}

function buildSourceNodeTargetsRootSource(
  node,
  relativePath,
  lexicalMetadata,
) {
  if (
    buildPathExpressionHasUnknownSegment(node, lexicalMetadata)
    || buildPathExpressionHasUnknownComposition(
      node,
      lexicalMetadata,
    )
    || buildUrlExpressionHasUnknownPath(node, lexicalMetadata)
  ) {
    return true;
  }
  const resolvedPath = buildPathExpressionValue(
    node,
    lexicalMetadata,
  ) ?? buildUrlExpressionValue(node, lexicalMetadata)
    ?? buildTemplatePathExpressionValue(node, lexicalMetadata);
  if (resolvedPath !== undefined) {
    return buildPathTargetsRootSource(resolvedPath);
  }
  const staticValue = staticStringExpressionValue(
    node,
    lexicalMetadata,
  );
  if (
    staticValue !== undefined
    && staticBuildInputTargetsRootSource(staticValue, relativePath)
    && !isWithinProvenNonRootPathCall(node, lexicalMetadata)
  ) {
    return true;
  }
  return staticValue === undefined
    && unresolvedTemplateTargetsRootSource(
      node,
      lexicalMetadata,
    );
}

function collectAstPolicyDescriptions(relativePath, source) {
  const sourceFile = parseArchitectureSource(relativePath, source);
  const lexicalMetadata = collectLexicalMetadata(sourceFile, relativePath);
  const descriptions = new Set();
  const adapterOrRoot = isAdapterOrCompositionRoot(relativePath);
  const sharedImplementation = isSharedImplementation(relativePath);
  const extensionAppSource = relativePath.startsWith('apps/extension/');
  const extensionBuildSource =
    (
      relativePath.startsWith('apps/extension/')
      && !relativePath.startsWith('apps/extension/src/')
    )
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
      && isDynamicModuleLoadCall(node, lexicalMetadata)
    ) {
      descriptions.add(
        'dynamic extension build loading can hide a frozen migration edge',
      );
    }
    if (extensionBuildSource) {
      if (
        buildSourceNodeTargetsRootSource(
          node,
          relativePath,
          lexicalMetadata,
        )
      ) {
        descriptions.add(
          'extension build source cannot reference root src/**',
        );
      }
    }
    if (globalObjectValueEscapes(node, lexicalMetadata)) {
      addNativeDescription(
        'global object value cannot escape adapter boundary',
      );
      descriptions.add(
        'global object value cannot escape adapter boundary',
      );
      if (
        extensionBuildSource
        || globalObjectEscapeKind(node, lexicalMetadata)
          === 'opaque-call'
      ) {
        descriptions.add(
          'global object cannot be passed to opaque calls',
        );
      }
    }
    if (codeGenerationValueEscapes(node, lexicalMetadata)) {
      descriptions.add('dynamic code generation is forbidden');
    }
    const transferCapabilityEscape = valueEscapeKind(
      node,
      (candidate) => expressionIsTransferSensitiveCapability(
        candidate,
        lexicalMetadata,
      ),
    );
    if (transferCapabilityEscape !== undefined) {
      descriptions.add(
        'sensitive architecture capability cannot escape its module',
      );
    }
    if (
      ts.isBinaryExpression(node)
      && isAssignmentOperator(node.operatorToken.kind)
      && expressionIsTransferSensitiveCapability(
        node.right,
        lexicalMetadata,
      )
    ) {
      descriptions.add(
        'sensitive architecture capability cannot escape its module',
      );
    }
    const nativeNamespaceEscape = valueEscapeKind(
      node,
      (candidate) => expressionIsNativeNamespaceValue(
        candidate,
        lexicalMetadata,
      ),
    );
    if (
      nativeNamespaceEscape !== undefined
      && (
        nativeNamespaceEscape !== 'opaque-call'
        || !compositionRoots.has(relativePath)
      )
    ) {
      descriptions.add(
        'raw native extension namespace cannot be exported',
      );
    }
    if (
      callUsesReflectCodeGenerationComposition(
        node,
        lexicalMetadata,
      )
    ) {
      descriptions.add('dynamic code generation is forbidden');
    }
    if (valueIsExportedVariableInitializer(node)) {
      if (expressionIsNativeNamespaceValue(node, lexicalMetadata)) {
        descriptions.add(
          'raw native extension namespace cannot be exported',
        );
      }
    }
    if (
      ts.isExportSpecifier(node)
      && expressionIsNativeNamespaceValue(
        node.propertyName ?? node.name,
        lexicalMetadata,
      )
    ) {
      descriptions.add(
        'raw native extension namespace cannot be exported',
      );
    }
    if (
      extensionBuildSource
      && (
        (
          ts.isExportAssignment(node)
          && expressionContainsBuildPathAnchor(
            node.expression,
            lexicalMetadata,
          )
        )
        || (
          ts.isExportSpecifier(node)
          && expressionContainsBuildPathAnchor(
            node.propertyName ?? node.name,
            lexicalMetadata,
          )
        )
      )
    ) {
      descriptions.add(
        'sensitive architecture capability cannot be exported',
      );
    }
    if (
      extensionBuildSource
      && ts.isFunctionDeclaration(node)
      && hasExportModifier(node)
      && functionReturnsBuildPathAnchor(
        node,
        lexicalMetadata,
      )
    ) {
      descriptions.add(
        'sensitive architecture capability cannot be exported',
      );
    }
    if (
      extensionBuildSource
      && ts.isClassDeclaration(node)
      && hasExportModifier(node)
      && expressionContainsBuildPathAnchor(
        node,
        lexicalMetadata,
      )
    ) {
      descriptions.add(
        'sensitive architecture capability cannot be exported',
      );
    }
    if (
      ts.isVariableStatement(node)
      && hasExportModifier(node)
    ) {
      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer
          ? unwrapExpression(declaration.initializer)
          : undefined;
        if (
          extensionBuildSource
          && initializer
          && (
            ts.isArrowFunction(initializer)
            || ts.isFunctionExpression(initializer)
          )
          && functionReturnsBuildPathAnchor(
            initializer,
            lexicalMetadata,
          )
        ) {
          descriptions.add(
            'sensitive architecture capability cannot be exported',
          );
        }
        const identifiers = [];
        collectBindingIdentifiers(declaration.name, identifiers);
        for (const identifier of identifiers) {
          if (
            expressionIsGlobalAlias(lexicalMetadata, identifier)
            || expressionIsCodeGenerationCallable(
              identifier,
              lexicalMetadata,
            )
            || expressionIsNativeNamespaceValue(
              identifier,
              lexicalMetadata,
            )
            || expressionIsTransferSensitiveCapability(
              identifier,
              lexicalMetadata,
            )
            || (
              extensionBuildSource
              && expressionContainsBuildPathAnchor(
                identifier,
                lexicalMetadata,
              )
            )
          ) {
            descriptions.add(
              'sensitive architecture capability cannot be exported',
            );
          }
        }
      }
    }
    if (
      ts.isBinaryExpression(node)
      && isAssignmentOperator(node.operatorToken.kind)
      && isCommonJsExportTarget(node.left, lexicalMetadata)
      && expressionContainsBuildPathAnchor(
        node.right,
        lexicalMetadata,
      )
    ) {
      descriptions.add(
        'sensitive architecture capability cannot be exported',
      );
    }
    if (
      (
        ts.isCallExpression(node)
        || ts.isNewExpression(node)
      )
      && expressionIsCodeGenerationCallable(
        node.expression,
        lexicalMetadata,
      )
    ) {
      descriptions.add('dynamic code generation is forbidden');
    }
    if (
      ts.isTaggedTemplateExpression(node)
      && expressionIsCodeGenerationCallable(
        node.tag,
        lexicalMetadata,
      )
    ) {
      descriptions.add('dynamic code generation is forbidden');
    }

    if (ts.isIdentifier(node)) {
      if (
        hiddenCodeGenerationNames.has(node.text)
        && !isPropertyNameIdentifier(node)
        && !isDeclarationNameIdentifier(node)
        && !resolveLexicalBinding(
          lexicalMetadata,
          node,
          node.text,
        ).bound
      ) {
        descriptions.add('dynamic code generation is forbidden');
      }
      if (legacyExtensionSymbolNames.has(node.text)) {
        descriptions.add('legacy ChromeLike compatibility symbol is forbidden');
      }
      if (/^(?:Chrome|Firefox)[A-Z]\w*$/u.test(node.text)) {
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
        && isBrowserSpecificIdentifierName(node.text)
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
        && !isWithinReflectGlobalAccess(node, lexicalMetadata)
      ) {
        descriptions.add('global bridge cannot hide a frozen migration edge');
      }
    }

    if (
      (
        ts.isVariableDeclaration(node)
        || ts.isParameter(node)
      )
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
    ) {
      const globalInitializer = isGlobalObjectExpression(
        node.initializer,
        lexicalMetadata,
      );
      for (const element of node.name.elements) {
        const propertyName = staticPropertyNameValue(
          element.propertyName ?? element.name,
          lexicalMetadata,
        );
        if (
          globalInitializer
          && hiddenCodeGenerationNames.has(propertyName)
        ) {
          descriptions.add('dynamic code generation is forbidden');
        }
        if (globalInitializer && propertyName === undefined) {
          descriptions.add(
            'dynamic browser-global member access is forbidden',
          );
          addNativeDescription(
            'native extension namespace access is adapter-only',
          );
        } else if (
          globalInitializer
          && nativeNamespaceNames.has(propertyName)
        ) {
          addNativeDescription(
            'native extension namespace access is adapter-only',
          );
        }
      }
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isObjectLiteralExpression(unwrapExpression(node.left))
    ) {
      const globalInitializer = isGlobalObjectExpression(
        node.right,
        lexicalMetadata,
      );
      for (const property of unwrapExpression(node.left).properties) {
        if (
          (
            ts.isPropertyAssignment(property)
            || ts.isShorthandPropertyAssignment(property)
          )
        ) {
          const propertyName = staticPropertyNameValue(
            property.name,
            lexicalMetadata,
          );
          if (
            globalInitializer
            && hiddenCodeGenerationNames.has(propertyName)
          ) {
            descriptions.add('dynamic code generation is forbidden');
          }
          if (globalInitializer && propertyName === undefined) {
            descriptions.add(
              'dynamic browser-global member access is forbidden',
            );
            addNativeDescription(
              'native extension namespace access is adapter-only',
            );
          } else if (
            globalInitializer
            && nativeNamespaceNames.has(propertyName)
          ) {
            addNativeDescription(
              'native extension namespace access is adapter-only',
            );
          }
        }
      }
    }

    if (
      ts.isPropertyAccessExpression(node)
      || ts.isElementAccessExpression(node)
    ) {
      const propertyName = memberPropertyName(node, lexicalMetadata);
      const globalChain = globalMemberChainInfo(node, lexicalMetadata);
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
      if (isGlobalObjectExpression(node.expression, lexicalMetadata)) {
        if (hiddenCodeGenerationNames.has(propertyName)) {
          descriptions.add('dynamic code generation is forbidden');
        } else if (propertyName === undefined) {
          descriptions.add(
            'dynamic browser-global member access is forbidden',
          );
          addNativeDescription(
            'native extension namespace access is adapter-only',
          );
          if (extensionAppSource) {
            descriptions.add(
              'global bridge cannot hide a frozen migration edge',
            );
          }
        } else if (nativeNamespaceNames.has(propertyName)) {
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
            && memberPropertyName(
              node.expression,
              lexicalMetadata,
            ) === 'runtime'
          )
        )
        && !adapterOrRoot
      ) {
        descriptions.add('browser error text control flow is adapter-only');
      }
    }

    if (isReflectGlobalAccess(node, lexicalMetadata)) {
      const propertyName = staticStringExpressionValue(
        node.arguments[1],
        lexicalMetadata,
      );
      if (hiddenCodeGenerationNames.has(propertyName)) {
        descriptions.add('dynamic code generation is forbidden');
      }
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

    const policyStringValue = staticStringExpressionValue(
      node,
      lexicalMetadata,
    );
    if (policyStringValue !== undefined) {
      if (
        !adapterOrRoot
        && /\b(?:chrome|moz)-extension:/iu.test(policyStringValue)
      ) {
        descriptions.add('platform extension URL scheme is adapter-only');
      }
      if (
        !adapterOrRoot
        && browserErrorTextPatterns.some(
          (pattern) => pattern.test(policyStringValue),
        )
        && isControlFlowTextLiteral(node)
      ) {
        descriptions.add('browser error text control flow is adapter-only');
      }
      if (
        sharedImplementation
        && /^(?:chrome|firefox)$/iu.test(policyStringValue)
        && isControlFlowTextLiteral(node)
      ) {
        descriptions.add(
          'shared implementation contains a browser-specific branch or brand',
        );
      }
    }
    if (
      ts.isBinaryExpression(node)
      && isAssignmentOperator(node.operatorToken.kind)
    ) {
      const assignedStringValue = staticStringExpressionValue(
        node.right,
        lexicalMetadata,
      );
      if (
        sharedImplementation
        && /^(?:chrome|firefox)$/iu.test(
          assignedStringValue ?? '',
        )
      ) {
        descriptions.add(
          'shared implementation contains a browser-specific branch or brand',
        );
      }
      if (
        !adapterOrRoot
        && browserErrorTextPatterns.some(
          (pattern) => pattern.test(assignedStringValue ?? ''),
        )
      ) {
        descriptions.add(
          'browser error text control flow is adapter-only',
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
        const propertyName = memberPropertyName(
          node.left,
          lexicalMetadata,
        );
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
  const lexicalMetadata = collectLexicalMetadata(
    sourceFile,
    relativePath,
  );
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
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      references.push({
        kind: 'static',
        specifier: node.moduleReference.expression.text,
      });
    } else if (
      ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)
    ) {
      references.push({
        kind: 'static',
        specifier: node.argument.literal.text,
      });
    } else if (ts.isCallExpression(node)) {
      if (isDynamicModuleLoadCall(node, lexicalMetadata)) {
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
    ...await collectSourceFiles(repositoryRoot, 'apps/extension'),
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
