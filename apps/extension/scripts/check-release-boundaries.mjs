import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import {
  init as initializeModuleLexer,
  parse as parseModuleImports,
} from 'es-module-lexer';
import canonicalModelManifest from '@shinobu/model-manifest/manifest'
  with { type: 'json' };
import ts from 'typescript';
import {
  generateExtensionManifest,
  serializeExtensionManifest,
} from './generate-manifest.mjs';
import {
  assertNoRemoteDetectionFallbackResources,
} from './detection-resource-boundary.mjs';
import { readCliOption } from './cli-options.mjs';

const root = resolve(import.meta.dirname, '../../..');
const argumentsList = process.argv.slice(2);
const requestedDistDir = readCliOption(argumentsList, '--dist');
const requestedModelSourceDirectory = readCliOption(
  argumentsList,
  '--model-source',
);
const distDir = requestedDistDir
  ? resolve(process.cwd(), requestedDistDir)
  : join(root, 'apps', 'extension', 'dist', 'chrome');
const target = readCliOption(argumentsList, '--target') ?? 'chrome';
if (!['chrome', 'firefox', 'benchmark'].includes(target)) {
  throw new Error(`Unsupported extension release target: ${target}`);
}
const benchmarkBuild = target === 'benchmark';
const manifestTarget = target === 'firefox' ? 'firefox' : 'chrome';
const canonicalModelSourceDirectory = requestedModelSourceDirectory
  ? resolve(process.cwd(), requestedModelSourceDirectory)
  : join(root, 'public', 'models');
const canonicalModelChecksumArtifactPath = 'models/models.sha256';
const canonicalModelAssets = new Map();
for (const asset of canonicalModelManifest.assets ?? []) {
  if (
    typeof asset?.path !== 'string'
    || asset.path.length === 0
    || asset.path.includes('/')
    || asset.path.includes('\\')
    || !Number.isSafeInteger(asset.size)
    || asset.size <= 0
    || typeof asset.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(asset.sha256)
  ) {
    throw new Error(
      `Canonical model manifest contains an invalid asset: ${JSON.stringify(asset)}`,
    );
  }
  const artifactPath = `models/${asset.path}`;
  if (canonicalModelAssets.has(artifactPath)) {
    throw new Error(
      `Canonical model manifest contains duplicate asset path: ${asset.path}`,
    );
  }
  canonicalModelAssets.set(artifactPath, asset);
}
if (canonicalModelAssets.size === 0) {
  throw new Error('Canonical model manifest must declare at least one asset.');
}
const requiredCanonicalModelArtifactPaths = [
  canonicalModelChecksumArtifactPath,
  ...canonicalModelAssets.keys(),
];
const forbiddenBridgeTokens = [
  '__shinobu_bake',
  '__shinobu_render',
  '__shinobu_bridge',
];
const forbiddenTestControlTokens = [
  '__shinobu_test_control',
  '__shinobu_conformance_control',
  '__shinobu_fault_injection',
];
const forbiddenTestControlPathSegments = new Set([
  '__tests__',
  'conformance',
  'fault-injection',
  'fault_injection',
  'fixture',
  'fixtures',
  'golden',
  'goldens',
  'test',
  'test-control',
  'test-controls',
  'tests',
]);
const forbiddenBenchmarkPathSegments = new Set([
  'benchmark',
  'benchmarks',
]);
const scannedTextArtifactExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.txt',
]);
const commonStoreArtifactPaths = new Set([
  'assets/popup.css',
  'assets/ort-wasm-simd-threaded.jsep.wasm',
  'background.js',
  'brand/shinobu-wordmark.svg',
  'chunks/extensionAdapter.js',
  'chunks/config.js',
  'chunks/diagnosticLog.js',
  'chunks/diagnosticLogClient.js',
  'chunks/diagnosticPrimitives.js',
  'chunks/localPipelineProtocol.js',
  'chunks/messages.js',
  'chunks/onnxWorkerBridge.js',
  'chunks/ortVendor.js',
  'chunks/perfTrace.js',
  'chunks/reactVendor.js',
  'content.js',
  'fonts/SourceHanSansCN-VF.ttf.woff2',
  'fonts/SourceHanSansTW-VF.ttf.woff2',
  'icons/icon.svg',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'manifest.json',
  'models/models.json',
  'onnxWorker.js',
  'ort/ort-wasm-simd-threaded.asyncify.mjs',
  'ort/ort-wasm-simd-threaded.asyncify.wasm',
  'ort/ort-wasm-simd-threaded.jsep.mjs',
  'ort/ort-wasm-simd-threaded.jsep.wasm',
  'ort/ort-wasm-simd-threaded.mjs',
  'ort/ort-wasm-simd-threaded.wasm',
  'popup.html',
  'popup.js',
]);
const chromeStoreArtifactPaths = new Set([
  'chunks/chromeLifecycle.js',
  'chunks/modulepreload-polyfill.js',
  'offscreen.html',
  'offscreen.js',
]);
const firefoxStoreArtifactPaths = new Set([
  'chunks/pipelineHostRuntime.js',
]);
const hashedWorkerAssetPattern =
  /^assets\/ort-wasm-simd-threaded\.jsep-[A-Za-z0-9_-]{8}\.wasm$/u;
const forbiddenLegacyWorkerTokens = [
  'runOcrBatchDecode',
  'runOcrSplitBatchDecode',
  'runOcrSingleDecode',
  'runOcrColorBatch',
  'runOcrColorSingle',
  'decodeAutoregressive',
  'gpuArgmax',
  'ocr_encoder',
  'ocr_decoder',
  'fg_ind',
];
const ortRuntimeModulePaths = [
  'ort/ort-wasm-simd-threaded.asyncify.mjs',
  'ort/ort-wasm-simd-threaded.jsep.mjs',
  'ort/ort-wasm-simd-threaded.mjs',
];
const ortRuntimeWasmPaths = [
  'ort/ort-wasm-simd-threaded.asyncify.wasm',
  'ort/ort-wasm-simd-threaded.jsep.wasm',
  'ort/ort-wasm-simd-threaded.wasm',
];
const benchmarkArtifacts = [
  'benchmark.html',
  'benchmark.js',
  'benchmark-chunks',
  'benchmark-assets',
];
const forbiddenLegacyModelArtifacts = [
  'ocr.onnx',
  'ocr_encoder.onnx',
  'ocr_decoder.onnx',
  'ocr_dict.txt',
  'ch_PP-OCRv5_rec_mobile.onnx',
  'paddleocr_v5_dict.txt',
  'PP-OCRv6_small_rec.onnx',
  'lama_fp32.onnx',
];
const requiredReleaseArtifacts = [
  'manifest.json',
  'models/models.json',
  'popup.html',
  'popup.js',
  'background.js',
  'content.js',
  'chunks/messages.js',
  'chunks/localPipelineProtocol.js',
  'chunks/perfTrace.js',
  'onnxWorker.js',
  ...requiredCanonicalModelArtifactPaths,
  ...ortRuntimeModulePaths,
  ...ortRuntimeWasmPaths,
];
if (manifestTarget === 'chrome') {
  requiredReleaseArtifacts.push(
    'offscreen.html',
    'offscreen.js',
    'chunks/onnxWorkerBridge.js',
  );
} else {
  requiredReleaseArtifacts.push(
    'chunks/pipelineHostRuntime.js',
  );
}

function collectArtifactPaths(directory, baseDirectory = directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...collectArtifactPaths(path, baseDirectory));
    } else if (entry.isFile()) {
      paths.push(
        path
          .slice(baseDirectory.length + 1)
          .replaceAll('\\', '/'),
      );
    }
  }
  return paths.sort();
}

function pathSegmentMatches(segment, controlledNames) {
  const normalized = segment.toLowerCase();
  return [...controlledNames].some((name) =>
    normalized === name
    || normalized.startsWith(`${name}.`)
    || normalized.startsWith(`${name}-`)
    || normalized.startsWith(`${name}_`));
}

function classifyNonReleaseArtifact(path) {
  const segments = path.split('/');
  if (
    segments.some((segment) =>
      pathSegmentMatches(segment, forbiddenBenchmarkPathSegments))
  ) {
    return 'benchmark-only';
  }
  if (
    segments.some((segment) =>
      pathSegmentMatches(segment, forbiddenTestControlPathSegments))
  ) {
    return 'test-control';
  }
  return undefined;
}

function isApprovedStoreArtifact(path) {
  return commonStoreArtifactPaths.has(path)
    || canonicalModelAssets.has(path)
    || path === canonicalModelChecksumArtifactPath
    || (
      manifestTarget === 'chrome'
      && chromeStoreArtifactPaths.has(path)
    )
    || (
      manifestTarget === 'firefox'
      && firefoxStoreArtifactPaths.has(path)
    )
    || hashedWorkerAssetPattern.test(path);
}

function matchesResourcePattern(pattern, resource) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(resource);
}

function parseCanonicalModelChecksums(source) {
  const checksums = new Map();
  for (const [lineIndex, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/u);
    if (!match) {
      throw new Error(
        `Canonical model checksum contains invalid line ${lineIndex + 1}.`,
      );
    }
    const assetName = match[2].trim();
    const artifactPath = `models/${assetName}`;
    if (!canonicalModelAssets.has(artifactPath)) {
      throw new Error(
        `Canonical model checksum contains undeclared asset: ${assetName}`,
      );
    }
    if (checksums.has(artifactPath)) {
      throw new Error(
        `Canonical model checksum contains duplicate asset: ${assetName}`,
      );
    }
    checksums.set(artifactPath, match[1].toLowerCase());
  }
  return checksums;
}

function assertCanonicalModelInventory({
  directory,
  displayPrefix,
  inventoryLabel,
}) {
  const checksumPath = join(directory, 'models.sha256');
  if (!existsSync(checksumPath)) {
    throw new Error(
      `${inventoryLabel} is missing required canonical model artifact: ${displayPrefix}models.sha256`,
    );
  }
  const checksums = parseCanonicalModelChecksums(
    readFileSync(checksumPath, 'utf8'),
  );
  for (const [, asset] of canonicalModelAssets) {
    const checksum = checksums.get(`models/${asset.path}`);
    if (checksum === undefined) {
      throw new Error(
        `Canonical model checksum is missing asset: ${asset.path}`,
      );
    }
    if (checksum !== asset.sha256) {
      throw new Error(
        `Canonical model checksum mismatch for ${asset.path}: expected ${asset.sha256}, received ${checksum}.`,
      );
    }
  }

  for (const [, asset] of canonicalModelAssets) {
    const displayPath = `${displayPrefix}${asset.path}`;
    const absolutePath = join(directory, asset.path);
    if (!existsSync(absolutePath)) {
      throw new Error(
        `${inventoryLabel} is missing required canonical model artifact: ${displayPath}`,
      );
    }
    const actualSize = statSync(absolutePath).size;
    if (actualSize !== asset.size) {
      throw new Error(
        `Canonical model asset size mismatch for ${displayPath}: expected ${asset.size} bytes, received ${actualSize}.`,
      );
    }
    const actualHash = createHash('sha256')
      .update(readFileSync(absolutePath))
      .digest('hex');
    if (actualHash !== asset.sha256) {
      throw new Error(
        `Canonical model asset hash mismatch for ${displayPath}: expected ${asset.sha256}, received ${actualHash}.`,
      );
    }
  }
}

function resolvePackagedReference(
  ownerPath,
  reference,
  moduleSpecifier = false,
) {
  const withoutFragment = reference.split(/[?#]/u, 1)[0];
  if (!withoutFragment || withoutFragment.startsWith('#')) {
    if (moduleSpecifier) {
      throw new Error(
        `Artifact ${ownerPath} contains non-packaged reference: ${reference}`,
      );
    }
    return undefined;
  }
  if (
    !moduleSpecifier
    && withoutFragment.startsWith('data:')
  ) {
    return undefined;
  }
  if (
    /^[a-z][a-z\d+.-]*:/iu.test(withoutFragment)
    || (
      moduleSpecifier
      && !withoutFragment.startsWith('.')
      && !withoutFragment.startsWith('/')
    )
  ) {
    throw new Error(
      `Artifact ${ownerPath} contains non-packaged reference: ${reference}`,
    );
  }
  const resolvedPath = withoutFragment.startsWith('/')
    ? posix.normalize(withoutFragment.slice(1))
    : posix.normalize(
      posix.join(posix.dirname(ownerPath), withoutFragment),
    );
  if (
    !resolvedPath
    || resolvedPath === '..'
    || resolvedPath.startsWith('../')
    || posix.isAbsolute(resolvedPath)
  ) {
    throw new Error(
      `Artifact ${ownerPath} contains unsafe reference: ${reference}`,
    );
  }
  return resolvedPath;
}

await initializeModuleLexer;

function createSourceTypeChecker(sourcePath, source, sourceFile) {
  const compilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = {
    fileExists: (fileName) => fileName === sourcePath,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => '',
    getDefaultLibFileName: () => 'lib.d.ts',
    getDirectories: () => [],
    getNewLine: () => '\n',
    getSourceFile: (fileName) =>
      fileName === sourcePath ? sourceFile : undefined,
    readFile: (fileName) =>
      fileName === sourcePath ? source : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  return ts.createProgram(
    [sourcePath],
    compilerOptions,
    host,
  ).getTypeChecker();
}

function findVisibleConstInitializer(identifier, typeChecker) {
  const declaration =
    typeChecker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (
    declaration === undefined
    || !ts.isVariableDeclaration(declaration)
    || !ts.isIdentifier(declaration.name)
    || !ts.isVariableDeclarationList(declaration.parent)
    || (
      declaration.parent.flags & ts.NodeFlags.Const
    ) === 0
  ) {
    return undefined;
  }
  return declaration.initializer;
}

function extensionRuntimeNamespace(expression, typeChecker) {
  if (
    !ts.isCallExpression(expression)
    || expression.arguments.length !== 1
    || !ts.isPropertyAccessExpression(expression.expression)
    || expression.expression.name.text !== 'getURL'
  ) {
    return undefined;
  }
  const runtimeAccess = expression.expression.expression;
  const runtimeIdentifier = ts.isPropertyAccessExpression(runtimeAccess)
    ? runtimeAccess.expression
    : undefined;
  if (
    ts.isPropertyAccessExpression(runtimeAccess)
    && runtimeAccess.name.text === 'runtime'
    && ts.isIdentifier(runtimeIdentifier)
    && (
      runtimeIdentifier.text === 'browser'
      || runtimeIdentifier.text === 'chrome'
    )
    && typeChecker.getSymbolAtLocation(runtimeIdentifier) === undefined
  ) {
    return runtimeIdentifier.text;
  }
  return undefined;
}

function isExtensionRuntimeGetUrlCall(expression, typeChecker) {
  return extensionRuntimeNamespace(expression, typeChecker) !== undefined;
}

function isImportMetaUrl(expression) {
  return (
    ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'url'
    && ts.isMetaProperty(expression.expression)
    && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && expression.expression.name.text === 'meta'
  );
}

function isArtifactUrlConstruction(expression, typeChecker) {
  return (
    ts.isNewExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'URL'
    && typeChecker.getSymbolAtLocation(expression.expression) === undefined
    && expression.arguments?.length === 2
    && isImportMetaUrl(expression.arguments[1])
  );
}

function evaluateStaticImportReference(
  expression,
  typeChecker,
  visited = new Set(),
) {
  if (
    ts.isStringLiteral(expression)
    || ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return evaluateStaticImportReference(
      expression.expression,
      typeChecker,
      visited,
    );
  }
  if (
    ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateStaticImportReference(
      expression.left,
      typeChecker,
      visited,
    );
    const right = evaluateStaticImportReference(
      expression.right,
      typeChecker,
      visited,
    );
    return left === undefined || right === undefined
      ? undefined
      : left + right;
  }
  if (isExtensionRuntimeGetUrlCall(expression, typeChecker)) {
    const packagedPath = evaluateStaticImportReference(
      expression.arguments[0],
      typeChecker,
      visited,
    );
    if (packagedPath === undefined || packagedPath.startsWith('/')) {
      return packagedPath;
    }
    return `/${packagedPath.replace(/^\.\//u, '')}`;
  }
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }
  const initializer = findVisibleConstInitializer(
    expression,
    typeChecker,
  );
  if (initializer === undefined || visited.has(initializer)) {
    return undefined;
  }
  visited.add(initializer);
  const reference = evaluateStaticImportReference(
    initializer,
    typeChecker,
    visited,
  );
  visited.delete(initializer);
  return reference;
}

function collectJavaScriptReferences(sourcePath, source) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const typeChecker = createSourceTypeChecker(
    sourcePath,
    source,
    sourceFile,
  );
  const references = [];
  const assetReferences = [];
  const runtimeResourceReferences = [];
  const visit = (node) => {
    if (isArtifactUrlConstruction(node, typeChecker)) {
      const reference = evaluateStaticImportReference(
        node.arguments[0],
        typeChecker,
      );
      if (reference === undefined) {
        const location = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        throw new Error(
          `Artifact ${sourcePath} contains new URL(..., import.meta.url) reference that cannot be statically resolved at ${
            location.line + 1
          }:${location.character + 1}.`,
        );
      }
      assetReferences.push(reference);
    }
    if (
      ts.isCallExpression(node)
      && isExtensionRuntimeGetUrlCall(node, typeChecker)
    ) {
      const reference = evaluateStaticImportReference(
        node,
        typeChecker,
      );
      if (reference === undefined) {
        const location = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        throw new Error(
          `Artifact ${sourcePath} contains ${
            extensionRuntimeNamespace(node, typeChecker)
          }.runtime.getURL reference that cannot be statically resolved at ${
            location.line + 1
          }:${location.character + 1}.`,
        );
      }
      runtimeResourceReferences.push(reference);
    }
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const reference = node.arguments.length === 1
        ? evaluateStaticImportReference(
          node.arguments[0],
          typeChecker,
        )
        : undefined;
      if (reference === undefined) {
        const location = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        throw new Error(
          `Artifact ${sourcePath} contains dynamic import that cannot be statically resolved at ${
            location.line + 1
          }:${location.character + 1}.`,
        );
      }
      references.push(reference);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    assetReferences,
    references,
    runtimeResourceReferences,
  };
}

function collectArtifactReferences(path, source) {
  const assetReferences = [];
  const references = [];
  const runtimeResourceReferences = [];
  const addMatches = (expression) => {
    for (const match of source.matchAll(expression)) {
      references.push(match[1]);
    }
  };
  if (path.endsWith('.html')) {
    addMatches(/\b(?:href|src)=["']([^"']+)["']/giu);
  } else if (path.endsWith('.js') || path.endsWith('.mjs')) {
    const [imports] = parseModuleImports(source);
    for (const moduleImport of imports) {
      if (moduleImport.d === -1) {
        references.push(
          moduleImport.n
            ?? source.slice(moduleImport.s, moduleImport.e),
        );
      }
    }
    const javaScriptReferences = collectJavaScriptReferences(
      path,
      source,
    );
    references.push(...javaScriptReferences.references);
    assetReferences.push(...javaScriptReferences.assetReferences);
    runtimeResourceReferences.push(
      ...javaScriptReferences.runtimeResourceReferences,
    );
  } else if (path.endsWith('.css')) {
    addMatches(/\burl\(\s*["']?([^"')]+)["']?\s*\)/giu);
  }
  return {
    assetReferences,
    references,
    runtimeResourceReferences,
  };
}

function assertArtifactReferences(artifactPaths) {
  const artifactPathSet = new Set(artifactPaths);
  const contentRuntimeResources = new Set();
  for (const ownerPath of artifactPaths) {
    if (
      !ownerPath.endsWith('.html')
      && !ownerPath.endsWith('.js')
      && !ownerPath.endsWith('.mjs')
      && !ownerPath.endsWith('.css')
    ) {
      continue;
    }
    const source = readFileSync(join(distDir, ownerPath), 'utf8');
    const collectedReferences = collectArtifactReferences(
      ownerPath,
      source,
    );
    for (const reference of collectedReferences.references) {
      const referencedPath = resolvePackagedReference(
        ownerPath,
        reference,
        ownerPath.endsWith('.js') || ownerPath.endsWith('.mjs'),
      );
      if (
        referencedPath !== undefined
        && !artifactPathSet.has(referencedPath)
      ) {
        throw new Error(
          `Artifact ${ownerPath} references missing artifact: ${referencedPath}`,
        );
      }
    }
    for (const reference of collectedReferences.assetReferences) {
      const referencedPath = resolvePackagedReference(
        ownerPath,
        reference,
      );
      if (
        referencedPath !== undefined
        && !artifactPathSet.has(referencedPath)
      ) {
        throw new Error(
          `Artifact ${ownerPath} references missing artifact: ${referencedPath}`,
        );
      }
    }
    for (
      const reference of collectedReferences.runtimeResourceReferences
    ) {
      const referencedPath = resolvePackagedReference(
        ownerPath,
        reference,
        true,
      );
      if (
        ownerPath !== 'content.js'
        && referencedPath !== undefined
        && !artifactPathSet.has(referencedPath)
      ) {
        throw new Error(
          `Artifact ${ownerPath} references missing artifact: ${referencedPath}`,
        );
      }
      if (
        ownerPath === 'content.js'
        && referencedPath !== undefined
      ) {
        contentRuntimeResources.add(referencedPath);
      }
    }
  }
  return contentRuntimeResources;
}

function assertSafeManifestArtifactPath(path, label) {
  if (
    typeof path !== 'string'
    || path.length === 0
    || path.includes('\\')
    || path.startsWith('/')
    || path.split('/').some((segment) =>
      segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(
      `Manifest reference ${label} is not a safe packaged artifact path: ${String(path)}`,
    );
  }
}

function assertManifestReference(path, label) {
  assertSafeManifestArtifactPath(path, label);
  const artifactPath = join(distDir, path);
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw new Error(
      `Manifest reference ${label} is missing artifact: ${path}`,
    );
  }
}

function isPrivateRuntimeArtifact(path) {
  return new Set([
    'background.js',
    'offscreen.html',
    'offscreen.js',
    'onnxWorker.js',
    'chunks/onnxWorkerBridge.js',
  ]).has(path)
    || path.startsWith('models/')
    || path.startsWith('ort/');
}

function collectManifestReferences(manifest) {
  const references = [];
  const add = (label, path) => {
    if (path !== undefined) references.push({ label, path });
  };
  add('action.default_popup', manifest.action?.default_popup);
  for (const [size, path] of Object.entries(
    manifest.action?.default_icon ?? {},
  )) {
    add(`action.default_icon.${size}`, path);
  }
  for (const [size, path] of Object.entries(manifest.icons ?? {})) {
    add(`icons.${size}`, path);
  }
  add(
    'background.service_worker',
    manifest.background?.service_worker,
  );
  for (const [index, path] of (
    manifest.background?.scripts ?? []
  ).entries()) {
    add(`background.scripts[${index}]`, path);
  }
  for (const [scriptIndex, contentScript] of (
    manifest.content_scripts ?? []
  ).entries()) {
    for (const field of ['js', 'css']) {
      for (const [fileIndex, path] of (
        contentScript[field] ?? []
      ).entries()) {
        add(
          `content_scripts[${scriptIndex}].${field}[${fileIndex}]`,
          path,
        );
      }
    }
  }
  return references;
}

if (!existsSync(distDir)) {
  throw new Error(`Release artifact directory does not exist: ${distDir}`);
}

assertCanonicalModelInventory({
  directory: canonicalModelSourceDirectory,
  displayPrefix: 'public/models/',
  inventoryLabel: 'Release source',
});
assertCanonicalModelInventory({
  directory: join(distDir, 'models'),
  displayPrefix: 'models/',
  inventoryLabel: 'Release build',
});

assertNoRemoteDetectionFallbackResources(distDir);

for (const artifact of requiredReleaseArtifacts) {
  if (!existsSync(join(distDir, artifact))) {
    throw new Error(`Release build is missing required artifact: ${artifact}`);
  }
}

const artifactPaths = collectArtifactPaths(distDir);
for (const artifactPath of artifactPaths) {
  const extension = posix.extname(artifactPath).toLowerCase();
  if (!scannedTextArtifactExtensions.has(extension)) continue;
  const source = readFileSync(join(distDir, artifactPath), 'utf8');
  for (const token of forbiddenBridgeTokens) {
    if (source.includes(token)) {
      throw new Error(
        `Release artifact contains forbidden benchmark bridge token ${token}: ${artifactPath}`,
      );
    }
  }
  for (const token of forbiddenTestControlTokens) {
    if (source.includes(token)) {
      throw new Error(
        `Release artifact contains forbidden test-control token ${token}: ${artifactPath}`,
      );
    }
  }
  if (extension !== '.js' && extension !== '.mjs') continue;
  try {
    execFileSync(
      process.execPath,
      ['--check', join(distDir, artifactPath)],
      { stdio: 'pipe' },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `JavaScript syntax check failed for ${artifactPath}: ${detail}`,
    );
  }
}

for (const path of ortRuntimeModulePaths) {
  const runtimeModule = await import(
    pathToFileURL(join(distDir, path)).href
  );
  if (typeof runtimeModule.default !== 'function') {
    throw new Error(
      `ORT runtime module must export a default factory: ${path}`,
    );
  }
}

const workerSource = readFileSync(join(distDir, 'onnxWorker.js'), 'utf8');
for (const token of forbiddenLegacyWorkerTokens) {
  if (workerSource.includes(token)) {
    throw new Error(`Release Worker contains forbidden legacy OCR token ${token}`);
  }
}

const manifestPath = join(distDir, 'manifest.json');
const manifestBytes = readFileSync(manifestPath);
const expectedManifest = generateExtensionManifest({
  target: manifestTarget,
});
const expectedManifestBytes = Buffer.from(
  serializeExtensionManifest(expectedManifest),
  'utf8',
);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (manifest.manifest_version !== expectedManifest.manifest_version) {
  throw new Error('Release manifest must use Manifest V3.');
}
if (
  !isDeepStrictEqual(
    manifest.content_security_policy,
    expectedManifest.content_security_policy,
  )
) {
  throw new Error(
    'Release manifest CSP must exactly match the declarative specification.',
  );
}
if (manifestTarget === 'chrome') {
  if (Object.hasOwn(manifest, 'browser_specific_settings')) {
    throw new Error(
      'Chrome manifest must not contain Gecko-specific browser_specific_settings.',
    );
  }
  if (Object.hasOwn(manifest.background ?? {}, 'scripts')) {
    throw new Error(
      'Chrome manifest must not contain background.scripts.',
    );
  }
} else {
  if (Object.hasOwn(manifest.background ?? {}, 'service_worker')) {
    throw new Error(
      'Firefox manifest must not contain background.service_worker.',
    );
  }
  if (Object.hasOwn(manifest, 'minimum_chrome_version')) {
    throw new Error(
      'Firefox manifest must not contain minimum_chrome_version.',
    );
  }
  if ((manifest.permissions ?? []).includes('offscreen')) {
    throw new Error(
      'Firefox manifest must not request the offscreen permission.',
    );
  }
  if ((manifest.permissions ?? []).includes('cookies')) {
    throw new Error(
      'Firefox manifest must keep cookies optional.',
    );
  }
}
if (
  !isDeepStrictEqual(
    manifest.permissions,
    expectedManifest.permissions,
  )
) {
  throw new Error(
    `${manifestTarget === 'chrome' ? 'Chrome' : 'Firefox'} manifest permissions must exactly match the declarative specification.`,
  );
}
if (
  !isDeepStrictEqual(
    manifest.optional_permissions,
    expectedManifest.optional_permissions,
  )
) {
  throw new Error(
    `${manifestTarget === 'chrome' ? 'Chrome' : 'Firefox'} manifest optional permissions must exactly match the declarative specification.`,
  );
}
if (
  !isDeepStrictEqual(
    manifest.background,
    expectedManifest.background,
  )
) {
  throw new Error(
    `${manifestTarget === 'chrome' ? 'Chrome' : 'Firefox'} manifest background must exactly match the declarative specification.`,
  );
}
for (const { label, path } of collectManifestReferences(manifest)) {
  assertManifestReference(path, label);
}
if (!benchmarkBuild) {
  for (const artifactPath of artifactPaths) {
    const classification = classifyNonReleaseArtifact(artifactPath);
    if (classification) {
      throw new Error(
        `Release build contains ${classification} artifact: ${artifactPath}`,
      );
    }
    if (!isApprovedStoreArtifact(artifactPath)) {
      throw new Error(
        `Release build contains artifact outside the ${manifestTarget} store boundary: ${artifactPath}`,
      );
    }
  }
}
const contentRuntimeResources =
  assertArtifactReferences(artifactPaths);
for (const [entryIndex, entry] of (
  manifest.web_accessible_resources ?? []
).entries()) {
  for (const [resourceIndex, pattern] of (
    entry.resources ?? []
  ).entries()) {
    const label =
      `web_accessible_resources[${entryIndex}].resources[${resourceIndex}]`;
    assertSafeManifestArtifactPath(pattern, label);
    if (
      !artifactPaths.some((artifactPath) =>
        matchesResourcePattern(pattern, artifactPath))
    ) {
      throw new Error(
        `Manifest resource ${label} matches no packaged artifact: ${pattern}`,
      );
    }
    const exposedPrivateArtifact = artifactPaths.find(
      (artifactPath) =>
        isPrivateRuntimeArtifact(artifactPath)
        && matchesResourcePattern(pattern, artifactPath),
    );
    if (exposedPrivateArtifact) {
      throw new Error(
        `Manifest resource ${label} exposes private artifact ${exposedPrivateArtifact}: ${pattern}`,
      );
    }
  }
}
const extensionPackage = JSON.parse(
  readFileSync(join(root, 'apps', 'extension', 'package.json'), 'utf8'),
);
if (manifest.version !== extensionPackage.version) {
  throw new Error(
    `Extension manifest version ${manifest.version} does not match workspace version ${extensionPackage.version}.`,
  );
}
if (manifestTarget === 'chrome') {
  if (manifest.minimum_chrome_version !== '109') {
    throw new Error('Chrome manifest must require Chromium 109 for the Offscreen API.');
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('offscreen')) {
    throw new Error('Chrome manifest is missing the offscreen permission.');
  }
} else {
  if (
    existsSync(join(distDir, 'offscreen.html'))
    || existsSync(join(distDir, 'offscreen.js'))
  ) {
    throw new Error('Firefox release build contains a Chrome-only offscreen host.');
  }
  if (
    manifest.browser_specific_settings?.gecko?.id
      !== 'shinobu-translator@donutshinobu'
    || manifest.browser_specific_settings?.gecko?.strict_min_version !== '140.0'
    || manifest.browser_specific_settings?.gecko_android?.strict_min_version !== '142.0'
    || manifest.browser_specific_settings?.gecko_android?.strict_max_version !== '141.*'
  ) {
    throw new Error('Firefox manifest is missing the fixed desktop-only Gecko identity contract.');
  }
}
if (!String(manifest.content_security_policy?.extension_pages ?? '').includes("worker-src 'self'")) {
  throw new Error("Release manifest must explicitly restrict worker-src to 'self'.");
}
const exposedResources = (manifest.web_accessible_resources ?? [])
  .flatMap((entry) => Array.isArray(entry.resources) ? entry.resources : []);
for (const resource of contentRuntimeResources) {
  if (!existsSync(join(distDir, resource))) {
    throw new Error(`Content script references missing runtime resource: ${resource}`);
  }
  if (!exposedResources.some((pattern) => matchesResourcePattern(pattern, resource))) {
    throw new Error(
      `Content script runtime resource is not declared web-accessible: ${resource}`,
    );
  }
}
for (const privateArtifact of ['models/*', 'ort/*', 'onnxWorker.js', 'chunks/*', 'chunks/onnxWorkerBridge.js']) {
  if (exposedResources.includes(privateArtifact)) {
    throw new Error(`Release manifest exposes private offscreen runtime artifact: ${privateArtifact}`);
  }
}

for (const artifact of forbiddenLegacyModelArtifacts) {
  if (existsSync(join(distDir, 'models', artifact))) {
    throw new Error(`Release build contains forbidden legacy model artifact: ${artifact}`);
  }
}

if (benchmarkBuild) {
  for (const artifact of ['benchmark.html', 'benchmark.js']) {
    if (!existsSync(join(distDir, artifact))) {
      throw new Error(`Benchmark build is missing required artifact: ${artifact}`);
    }
  }
} else {
  for (const artifact of benchmarkArtifacts) {
    if (existsSync(join(distDir, artifact))) {
      throw new Error(`Release build contains benchmark-only artifact: ${artifact}`);
    }
  }
}

if (!manifestBytes.equals(expectedManifestBytes)) {
  throw new Error(
    `${target} manifest does not byte-match the declarative source and extension workspace version.`,
  );
}

console.log(
  benchmarkBuild
    ? 'Benchmark artifacts are isolated from the release content bridge.'
    : `${target} release artifacts contain no benchmark bridge, benchmark-only entry, or legacy OCR Worker API.`,
);
