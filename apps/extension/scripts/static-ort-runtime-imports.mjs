import { fileURLToPath } from 'node:url';
import {
  init as initializeModuleLexer,
  parse as parseModuleImports,
} from 'es-module-lexer';

const ortRuntimeImporterPath = fileURLToPath(
  new URL('../src/ort/import-runtime-module.mjs', import.meta.url),
).replaceAll('\\', '/');
const packagedOrtRuntimeModulePattern =
  /^\/ort\/ort-wasm-simd-threaded(?:\.asyncify|\.jsep)?\.mjs$/u;

export function isPackagedOrtRuntimeModule(id) {
  return packagedOrtRuntimeModulePattern.test(
    id.replaceAll('\\', '/').split('?', 1)[0],
  );
}

function isOrtBrowserBundle(id) {
  return id
    .replaceAll('\\', '/')
    .split('?', 1)[0]
    .endsWith(
      '/node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs',
    );
}

export function staticOrtRuntimeImportsPlugin() {
  return {
    name: 'static-ort-runtime-imports',
    enforce: 'pre',
    async transform(source, id) {
      if (!isOrtBrowserBundle(id)) {
        return undefined;
      }
      await initializeModuleLexer;
      const [imports] = parseModuleImports(source);
      const dynamicImports = imports.filter(
        (moduleImport) => moduleImport.d >= 0,
      );
      if (dynamicImports.length !== 1) {
        throw new Error(
          `Expected one ONNX Runtime dynamic import, found ${dynamicImports.length}.`,
        );
      }
      const moduleImport = dynamicImports[0];
      const argument = source.slice(moduleImport.s, moduleImport.e);
      const replacement =
        `__shinobuImportOrtRuntimeModule(${argument})`;
      const importStatement =
        'import { importOrtRuntimeModule as __shinobuImportOrtRuntimeModule } '
        + `from ${JSON.stringify(ortRuntimeImporterPath)};\n`;
      return {
        code: [
          importStatement,
          source.slice(0, moduleImport.ss),
          replacement,
          source.slice(moduleImport.se),
        ].join(''),
        map: null,
      };
    },
  };
}
