import { posix as posixPath } from 'node:path';
import ts from 'typescript';

function unwrapTransparentExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringLiteralText(node) {
  const expression = unwrapTransparentExpression(node);
  return ts.isStringLiteralLike(expression) ? expression.text : null;
}

function createSingleFileAnalysis(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const options = {
    allowJs: true,
    module: ts.ModuleKind.Preserve,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
    types: [],
  };
  const host = {
    fileExists: (candidate) => candidate === fileName,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => '',
    getDefaultLibFileName: () => 'lib.d.ts',
    getDirectories: () => [],
    getNewLine: () => '\n',
    getSourceFile: (candidate) => (
      candidate === fileName ? sourceFile : undefined
    ),
    readFile: (candidate) => (
      candidate === fileName ? source : undefined
    ),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  const program = ts.createProgram([fileName], options, host);
  return {
    checker: program.getTypeChecker(),
    sourceFile,
  };
}

function symbolAt(checker, node) {
  return checker.getSymbolAtLocation(node) ?? null;
}

function isUnboundIdentifier(node, expectedName, checker) {
  return ts.isIdentifier(node)
    && node.text === expectedName
    && symbolAt(checker, node) === null;
}

function requiredModuleSpecifier(node, checker) {
  const expression = unwrapTransparentExpression(node);
  if (
    !ts.isCallExpression(expression)
    || !isUnboundIdentifier(expression.expression, 'require', checker)
    || !expression.arguments[0]
  ) {
    return null;
  }
  return stringLiteralText(expression.arguments[0]);
}

function runtimeModuleBindings(
  sourceFile,
  checker,
  moduleName,
  approvedFunctions,
) {
  const functions = new Map();
  const namespaces = new Set();

  const addNamespace = (name) => {
    const symbol = symbolAt(checker, name);
    if (symbol) namespaces.add(symbol);
  };
  const addFunction = (name, importedName) => {
    if (!approvedFunctions.has(importedName)) return;
    const symbol = symbolAt(checker, name);
    if (symbol) functions.set(symbol, importedName);
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement)
      && stringLiteralText(statement.moduleSpecifier) === moduleName
      && statement.importClause
    ) {
      if (statement.importClause.name) {
        addNamespace(statement.importClause.name);
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        addNamespace(bindings.name);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          addFunction(
            binding.name,
            binding.propertyName?.text ?? binding.name.text,
          );
        }
      }
    }
    if (
      ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression
      && stringLiteralText(statement.moduleReference.expression) === moduleName
    ) {
      addNamespace(statement.name);
    }
  }

  function visit(node) {
    if (
      ts.isVariableDeclaration(node)
      && node.initializer
      && requiredModuleSpecifier(node.initializer, checker) === moduleName
    ) {
      if (ts.isIdentifier(node.name)) {
        addNamespace(node.name);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const binding of node.name.elements) {
          if (
            !binding.dotDotDotToken
            && ts.isIdentifier(binding.name)
          ) {
            const importedName = binding.propertyName
              ? stringLiteralText(binding.propertyName)
                ?? (
                  ts.isIdentifier(binding.propertyName)
                    ? binding.propertyName.text
                    : null
                )
              : binding.name.text;
            if (importedName) addFunction(binding.name, importedName);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return { functions, namespaces };
}

function nodePathBindings(sourceFile, checker) {
  return runtimeModuleBindings(
    sourceFile,
    checker,
    'node:path',
    new Set(['join', 'resolve']),
  );
}

function nodeUrlBindings(sourceFile, checker) {
  return runtimeModuleBindings(
    sourceFile,
    checker,
    'node:url',
    new Set(['fileURLToPath']),
  );
}

function topLevelConstBindings(sourceFile, checker) {
  const bindings = new Map();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement)
      || !(statement.declarationList.flags & ts.NodeFlags.Const)
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        const symbol = symbolAt(checker, declaration.name);
        if (symbol) bindings.set(symbol, declaration.initializer);
      }
    }
  }

  return bindings;
}

function pathOperationForCall(node, pathBindings, checker) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression)) {
    const symbol = symbolAt(checker, node.expression);
    return symbol ? pathBindings.functions.get(symbol) ?? null : null;
  }
  if (
    ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && pathBindings.namespaces.has(
      symbolAt(checker, node.expression.expression),
    )
    && (
      node.expression.name.text === 'resolve'
      || node.expression.name.text === 'join'
    )
  ) {
    return node.expression.name.text;
  }
  return null;
}

function isFileUrlToPathCall(
  node,
  urlBindings,
  checker,
) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) {
    const symbol = symbolAt(checker, node.expression);
    return symbol ? urlBindings.functions.has(symbol) : false;
  }
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && urlBindings.namespaces.has(
      symbolAt(checker, node.expression.expression),
    )
    && node.expression.name.text === 'fileURLToPath';
}

function isImportMetaProperty(node, propertyName) {
  const expression = unwrapTransparentExpression(node);
  return ts.isPropertyAccessExpression(expression)
    && expression.name.text === propertyName
    && ts.isMetaProperty(expression.expression)
    && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && expression.expression.name.text === 'meta';
}

export function findModuleReferences(source, fileName) {
  const { checker, sourceFile } = createSingleFileAnalysis(source, fileName);
  const references = [];
  const pathBindings = nodePathBindings(sourceFile, checker);
  const urlBindings = nodeUrlBindings(sourceFile, checker);
  const constBindings = topLevelConstBindings(sourceFile, checker);
  const normalizedFileName = fileName.replace(/\\/gu, '/');
  const sourceDirectory = posixPath.resolve(
    '/',
    posixPath.dirname(normalizedFileName),
  );

  function evaluateStaticPath(
    node,
    resolving = new Set(),
  ) {
    const expression = unwrapTransparentExpression(node);
    const literal = stringLiteralText(expression);
    if (literal !== null) {
      return { value: literal, anchored: false };
    }
    if (isImportMetaProperty(expression, 'dirname')) {
      return { value: sourceDirectory, anchored: true };
    }
    if (isImportMetaProperty(expression, 'url')) {
      return {
        value: posixPath.resolve('/', normalizedFileName),
        anchored: true,
      };
    }
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(checker, expression);
      if (expression.text === '__dirname' && !symbol) {
        return { value: sourceDirectory, anchored: true };
      }
      if (!symbol) return null;
      const initializer = constBindings.get(symbol);
      if (!initializer || resolving.has(symbol)) return null;
      const nextResolving = new Set(resolving);
      nextResolving.add(symbol);
      return evaluateStaticPath(initializer, nextResolving);
    }
    if (
      ts.isNewExpression(expression)
      && isUnboundIdentifier(expression.expression, 'URL', checker)
      && expression.arguments?.[0]
      && expression.arguments[1]
      && isImportMetaProperty(expression.arguments[1], 'url')
    ) {
      const relative = stringLiteralText(expression.arguments[0]);
      if (relative === null) return null;
      return {
        value: posixPath.resolve(sourceDirectory, relative),
        anchored: true,
      };
    }
    if (
      isFileUrlToPathCall(expression, urlBindings, checker)
      && expression.arguments[0]
    ) {
      const evaluated = evaluateStaticPath(
        expression.arguments[0],
        resolving,
      );
      return evaluated?.anchored ? evaluated : null;
    }

    const operation = pathOperationForCall(
      expression,
      pathBindings,
      checker,
    );
    if (!operation) return null;
    const argumentsList = [];
    let anchored = false;
    for (const argument of expression.arguments) {
      const evaluated = evaluateStaticPath(
        argument,
        resolving,
      );
      if (!evaluated) return null;
      argumentsList.push(evaluated.value);
      anchored ||= evaluated.anchored;
    }
    if (!anchored) return null;
    return {
      value: operation === 'resolve'
        ? posixPath.resolve(...argumentsList)
        : posixPath.join(...argumentsList),
      anchored: true,
    };
  }

  function moduleReferenceForPathCall(node) {
    const evaluated = evaluateStaticPath(node);
    if (!evaluated?.anchored) return null;
    const relative = posixPath.relative(sourceDirectory, evaluated.value);
    if (!relative) return '.';
    return relative.startsWith('.') ? relative : `./${relative}`;
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
        ? stringLiteralText(node.moduleSpecifier)
        : null;
      if (specifier !== null) references.push(specifier);
    }
    if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
    ) {
      const specifier = stringLiteralText(node.moduleReference.expression);
      if (specifier !== null) references.push(specifier);
    }
    if (
      ts.isCallExpression(node)
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (
          isUnboundIdentifier(node.expression, 'require', checker)
        )
      )
    ) {
      const specifier = node.arguments[0]
        ? stringLiteralText(node.arguments[0])
        : null;
      if (specifier !== null) references.push(specifier);
    }
    if (ts.isCallExpression(node)) {
      const specifier = pathOperationForCall(
        node,
        pathBindings,
        checker,
      )
        ? moduleReferenceForPathCall(node)
        : null;
      if (specifier !== null) references.push(specifier);
    }
    if (
      ts.isNewExpression(node)
      && isUnboundIdentifier(node.expression, 'URL', checker)
      && node.arguments?.[0]
      && node.arguments[1]
      && isImportMetaProperty(node.arguments[1], 'url')
    ) {
      const specifier = stringLiteralText(node.arguments[0]);
      if (specifier !== null) references.push(specifier);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}
