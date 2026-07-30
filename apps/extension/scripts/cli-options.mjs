export function readCliOption(argumentsList, name) {
  const inlinePrefix = `${name}=`;
  const inline = argumentsList.find((argument) =>
    argument.startsWith(inlinePrefix));
  if (inline) {
    const value = inline.slice(inlinePrefix.length);
    if (!value) throw new Error(`${name} requires a value`);
    return value;
  }

  const index = argumentsList.indexOf(name);
  if (index < 0) return undefined;
  const value = argumentsList[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}
