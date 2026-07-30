import { posix as posixPath } from 'node:path';
import ts from 'typescript';

function stringLiteralText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function nodePathBindings(sourceFile) {
  const functions = new Map();
  const namespaces = new Set();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || stringLiteralText(statement.moduleSpecifier) !== 'node:path'
      || !statement.importClause
    ) {
      continue;
    }
    if (statement.importClause.name) {
      namespaces.add(statement.importClause.name.text);
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const importedName = binding.propertyName?.text ?? binding.name.text;
        if (importedName === 'resolve' || importedName === 'join') {
          functions.set(binding.name.text, importedName);
        }
      }
    }
  }

  return { functions, namespaces };
}

function nodeUrlBindings(sourceFile) {
  const functions = new Set();
  const namespaces = new Set();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || stringLiteralText(statement.moduleSpecifier) !== 'node:url'
      || !statement.importClause
    ) {
      continue;
    }
    if (statement.importClause.name) {
      namespaces.add(statement.importClause.name.text);
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const importedName = binding.propertyName?.text ?? binding.name.text;
        if (importedName === 'fileURLToPath') {
          functions.add(binding.name.text);
        }
      }
    }
  }

  return { functions, namespaces };
}

function topLevelConstBindings(sourceFile) {
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
        bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  return bindings;
}

function pathOperationForCall(node, pathBindings, shadowedBindings = new Set()) {
  if (!ts.isCallExpression(node)) return null;
  if (
    ts.isIdentifier(node.expression)
    && !shadowedBindings.has(node.expression.text)
  ) {
    return pathBindings.functions.get(node.expression.text) ?? null;
  }
  if (
    ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && !shadowedBindings.has(node.expression.expression.text)
    && pathBindings.namespaces.has(node.expression.expression.text)
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
  shadowedBindings = new Set(),
) {
  if (!ts.isCallExpression(node)) return false;
  if (
    ts.isIdentifier(node.expression)
    && !shadowedBindings.has(node.expression.text)
  ) {
    return urlBindings.functions.has(node.expression.text);
  }
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && !shadowedBindings.has(node.expression.expression.text)
    && urlBindings.namespaces.has(node.expression.expression.text)
    && node.expression.name.text === 'fileURLToPath';
}

function isImportMetaProperty(node, propertyName) {
  return ts.isPropertyAccessExpression(node)
    && node.name.text === propertyName
    && ts.isMetaProperty(node.expression)
    && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && node.expression.name.text === 'meta';
}

export function findModuleReferences(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
  );
  const references = [];
  const pathBindings = nodePathBindings(sourceFile);
  const urlBindings = nodeUrlBindings(sourceFile);
  const constBindings = topLevelConstBindings(sourceFile);
  const normalizedFileName = fileName.replace(/\\/gu, '/');
  const sourceDirectory = posixPath.resolve(
    '/',
    posixPath.dirname(normalizedFileName),
  );

  function evaluateStaticPath(
    node,
    resolving = new Set(),
    shadowedBindings = new Set(),
  ) {
    const literal = stringLiteralText(node);
    if (literal !== null) {
      return { value: literal, anchored: false };
    }
    if (isImportMetaProperty(node, 'dirname')) {
      return { value: sourceDirectory, anchored: true };
    }
    if (isImportMetaProperty(node, 'url')) {
      return {
        value: posixPath.resolve('/', normalizedFileName),
        anchored: true,
      };
    }
    if (ts.isIdentifier(node)) {
      if (node.text === '__dirname') {
        return { value: sourceDirectory, anchored: true };
      }
      if (shadowedBindings.has(node.text)) return null;
      const initializer = constBindings.get(node.text);
      if (!initializer || resolving.has(node.text)) return null;
      const nextResolving = new Set(resolving);
      nextResolving.add(node.text);
      return evaluateStaticPath(initializer, nextResolving);
    }
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'URL'
      && node.arguments?.[0]
      && node.arguments[1]
      && isImportMetaProperty(node.arguments[1], 'url')
    ) {
      const relative = stringLiteralText(node.arguments[0]);
      if (relative === null) return null;
      return {
        value: posixPath.resolve(sourceDirectory, relative),
        anchored: true,
      };
    }
    if (
      isFileUrlToPathCall(node, urlBindings, shadowedBindings)
      && node.arguments[0]
    ) {
      const evaluated = evaluateStaticPath(
        node.arguments[0],
        resolving,
        shadowedBindings,
      );
      return evaluated?.anchored ? evaluated : null;
    }

    const operation = pathOperationForCall(
      node,
      pathBindings,
      shadowedBindings,
    );
    if (!operation) return null;
    const argumentsList = [];
    let anchored = false;
    for (const argument of node.arguments) {
      const evaluated = evaluateStaticPath(
        argument,
        resolving,
        shadowedBindings,
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

  function moduleReferenceForPathCall(node, shadowedBindings) {
    const evaluated = evaluateStaticPath(
      node,
      new Set(),
      shadowedBindings,
    );
    if (!evaluated?.anchored) return null;
    const relative = posixPath.relative(sourceDirectory, evaluated.value);
    if (!relative) return '.';
    return relative.startsWith('.') ? relative : `./${relative}`;
  }

  function visit(node, shadowedBindings = new Set()) {
    let childShadows = shadowedBindings;
    if (ts.isFunctionLike(node)) {
      childShadows = new Set(shadowedBindings);
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) {
          childShadows.add(parameter.name.text);
        }
      }
    }
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
          ts.isIdentifier(node.expression)
          && node.expression.text === 'require'
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
        shadowedBindings,
      )
        ? moduleReferenceForPathCall(node, shadowedBindings)
        : null;
      if (specifier !== null) references.push(specifier);
    }
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'URL'
      && node.arguments?.[0]
      && node.arguments[1]
      && isImportMetaProperty(node.arguments[1], 'url')
    ) {
      const specifier = stringLiteralText(node.arguments[0]);
      if (specifier !== null) references.push(specifier);
    }
    ts.forEachChild(node, (child) => visit(child, childShadows));
  }

  visit(sourceFile);
  return references;
}
