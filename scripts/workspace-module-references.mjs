import ts from 'typescript';

function stringLiteralText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function nodePathBindings(sourceFile) {
  const functions = new Set();
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
          functions.add(binding.name.text);
        }
      }
    }
  }

  return { functions, namespaces };
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

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
        ? stringLiteralText(node.moduleSpecifier)
        : null;
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
      const directPathCall = ts.isIdentifier(node.expression)
        && pathBindings.functions.has(node.expression.text);
      const namespacePathCall = ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && pathBindings.namespaces.has(node.expression.expression.text)
        && (
          node.expression.name.text === 'resolve'
          || node.expression.name.text === 'join'
        );
      if (directPathCall || namespacePathCall) {
        for (const argument of node.arguments) {
          const specifier = stringLiteralText(argument);
          if (specifier !== null) references.push(specifier);
        }
      }
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
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}
