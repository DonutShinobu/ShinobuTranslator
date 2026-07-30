import type { OutputBundle } from 'rollup';
import type { Plugin } from 'vite';

function toSafeIdentifier(identifier: string): string {
  return identifier.replace(/\$/g, '\\u0024');
}

function parseNamedImportBindings(
  bindings: string,
): Array<{ imported: string; local: string }> {
  return bindings.split(',').map((binding) => {
    const trimmed = binding.trim();
    const aliasMatch = trimmed.match(/^(\S+)\s+as\s+(\S+)$/);
    if (aliasMatch) {
      return {
        imported: aliasMatch[1],
        local: aliasMatch[2],
      };
    }
    return {
      imported: trimmed,
      local: trimmed,
    };
  });
}

function buildNamespaceAssignments(
  namespace: string,
  bindings: string,
): string {
  return parseNamedImportBindings(bindings)
    .map(({ imported, local }) => (
      `const ${toSafeIdentifier(local)}=${namespace}[${JSON.stringify(imported)}];`
    ))
    .join('');
}

export function rewriteClassicContentScriptBundle(
  bundle: OutputBundle,
): void {
  for (const [fileName, chunk] of Object.entries(bundle)) {
    if (chunk.type !== 'chunk' || fileName !== 'content.js') continue;

    chunk.code = chunk.code.replace(
      /\bimport\.meta\.url\b/g,
      'chrome.runtime.getURL("content.js")',
    );

    chunk.code = chunk.code.replace(
      /\bimport\(\s*"\.\/([^"]+)"\s*\)/g,
      'import(chrome.runtime.getURL("$1"))',
    );

    const exportMatch = chunk.code.match(/export\s*\{([^}]+)\}\s*;\s*$/);
    if (exportMatch) {
      const pairs = parseNamedImportBindings(exportMatch[1])
        .map(({ imported, local }) => (
          `${JSON.stringify(local)}:${toSafeIdentifier(imported)}`
        ));
      chunk.code = chunk.code.replace(
        /export\s*\{[^}]+\}\s*;\s*$/,
        () => `window.__shinobu_shared={${pairs.join(',')}};`,
      );
    }

    const staticImportPattern =
      /import\s*\{([^}]+)\}\s*from\s*"\.\/([^"]+)"\s*;?/g;
    const staticImports: Array<{
      full: string;
      bindings: string;
      path: string;
    }> = [];
    let match: RegExpExecArray | null;
    while ((match = staticImportPattern.exec(chunk.code)) !== null) {
      staticImports.push({
        full: match[0],
        bindings: match[1],
        path: match[2],
      });
    }
    if (staticImports.length > 0) {
      staticImports.forEach((staticImport, index) => {
        const namespace = `__shinobu_static_import_${index}`;
        chunk.code = chunk.code.replace(
          staticImport.full,
          () => (
            `const ${namespace}=await import(chrome.runtime.getURL("${staticImport.path}"));`
            + buildNamespaceAssignments(
              namespace,
              staticImport.bindings,
            )
          ),
        );
      });
      chunk.code = `(async()=>{${chunk.code}})();`;
    }
  }

  for (const [fileName, chunk] of Object.entries(bundle)) {
    if (chunk.type !== 'chunk' || !fileName.startsWith('chunks/')) continue;

    chunk.code = chunk.code.replace(
      /import\s*\{([^}]+)\}\s*from\s*"(\.\.\/content\.js|\.\/content\.js)"\s*;?/,
      (_match: string, imports: string) => {
        const namespace = '__shinobu_shared_import';
        return `const ${namespace}=window.__shinobu_shared;${
          buildNamespaceAssignments(namespace, imports)
        }`;
      },
    );

    chunk.code = chunk.code.replace(
      /\bimport\.meta\.url\b/g,
      `chrome.runtime.getURL("${fileName}")`,
    );
  }
}

/**
 * Content scripts are classic scripts in both supported extension targets.
 * This build adapter absorbs the native extension resource URL needed to load
 * Vite chunks without leaking that namespace into content business code.
 */
export function classicContentScriptAdapter(): Plugin {
  return {
    name: 'classic-content-script-adapter',
    enforce: 'post',
    generateBundle(_options, bundle) {
      rewriteClassicContentScriptBundle(bundle);
    },
  };
}
