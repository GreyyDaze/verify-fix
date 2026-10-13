import ts from "typescript";

/** Secret-free model derived from the checked-in Multistep source. */
export type RegionAccountMapping = Record<string, string>;

export function validatedRegionAccountMapping(value: unknown): RegionAccountMapping | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 256
    || entries.some(([region, key]) => !region || region.length > 256
      || typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))) return null;
  return Object.fromEntries(entries);
}

export function sameRegionAccountMapping(left: RegionAccountMapping, right: RegionAccountMapping): boolean {
  const normalize = (mapping: RegionAccountMapping) => Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function processEnvKey(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process"
    && node.expression.name.text === "env") return node.name.text;
  if (ts.isElementAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process"
    && node.expression.name.text === "env" && node.argumentExpression
    && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

function hasIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current) && current.text === name) found = true;
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function hasRequestPayloadUse(source: ts.SourceFile, variable: string): boolean {
  let used = false;
  const visit = (node: ts.Node) => {
    if (used) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^(post|put|patch|request)$/.test(node.expression.name.text)) {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        const payload = options.properties.find((property) => ts.isPropertyAssignment(property)
          && ["data", "json", "body"].includes(propertyName(property.name) ?? ""));
        if (payload && ts.isPropertyAssignment(payload) && hasIdentifier(payload.initializer, variable)) used = true;
      }
    }
    if (!used) ts.forEachChild(node, visit);
  };
  visit(source);
  return used;
}

function directMapAccess(node: ts.Expression, mapName: string, regionNames: Set<string>): boolean {
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === mapName) {
    const argument = node.argumentExpression;
    return !!argument && ((ts.isIdentifier(argument) && regionNames.has(argument.text))
      || processEnvKey(argument) === "REGION");
  }
  return false;
}

function undefinedGuard(node: ts.Expression, regionNames: Set<string>): boolean {
  if (!ts.isBinaryExpression(node)
    || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return false;
  const isUndefined = (value: ts.Expression) => ts.isIdentifier(value) && value.text === "undefined";
  const isRegion = (value: ts.Expression) => ts.isIdentifier(value) && regionNames.has(value.text);
  return isUndefined(node.left) && isRegion(node.right) || isRegion(node.left) && isUndefined(node.right);
}

function selectedFromMap(node: ts.Expression, mapName: string, regionNames: Set<string>): boolean {
  if (directMapAccess(node, mapName, regionNames)) return true;
  if (!ts.isConditionalExpression(node) || !undefinedGuard(node.condition, regionNames)) return false;
  const trueUndefined = ts.isIdentifier(node.whenTrue) && node.whenTrue.text === "undefined";
  const falseUndefined = ts.isIdentifier(node.whenFalse) && node.whenFalse.text === "undefined";
  return trueUndefined && directMapAccess(node.whenFalse, mapName, regionNames)
    || falseUndefined && directMapAccess(node.whenTrue, mapName, regionNames);
}

function sourceMappings(source: string, locations: string[], declared: Set<string>): RegionAccountMapping[] {
  const file = ts.createSourceFile("regional-account-source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) return [];
  // Shadowing the global process object makes a textual process.env read
  // ambiguous, so this source cannot establish a trusted mapping.
  let processShadowed = false;
  const regionAliases = new Set<string>();
  const declarations: ts.VariableDeclaration[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarations.push(node);
      if (node.name.text === "process") processShadowed = true;
      if (node.initializer && processEnvKey(node.initializer) === "REGION") regionAliases.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  if (processShadowed) return [];

  const out: RegionAccountMapping[] = [];
  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
    const entries: Array<[string, string]> = [];
    let valid = true;
    for (const property of declaration.initializer.properties) {
      if (!ts.isPropertyAssignment(property)) { valid = false; break; }
      const location = propertyName(property.name);
      const key = processEnvKey(property.initializer);
      if (!location || !key || entries.some(([prior]) => prior === location) || !declared.has(key)) { valid = false; break; }
      entries.push([location, key]);
    }
    if (!valid || entries.length !== locations.length || locations.some((location) => !entries.some(([entry]) => entry === location))) continue;
    const mapping = Object.fromEntries(entries);
    const mapName = declaration.name.text;
    const selected = declarations.some((selection) => {
      if (!ts.isIdentifier(selection.name) || selection.name.text === mapName || !selection.initializer
        || !selectedFromMap(selection.initializer, mapName, regionAliases)) return false;
      return hasRequestPayloadUse(file, selection.name.text);
    });
    if (selected) out.push(mapping);
  }
  return out;
}

/**
 * Recognize a direct, static region -> process.env key map which is selected
 * through the runner's REGION value and used in a request payload. This
 * returns names only; values are validated separately and never persisted.
 */
export function deriveRegionalAccountMapping(
  sources: Iterable<readonly [string, string]>,
  locations: string[],
  declaredEnvKeys: string[],
): RegionAccountMapping | null {
  if (locations.length === 0 || new Set(locations).size !== locations.length
    || locations.some((location) => !location || location.length > 256 || /[\u0000-\u001f\u007f]/.test(location))) return null;
  const declared = new Set(declaredEnvKeys);
  const mappings = [...sources].flatMap(([, source]) => sourceMappings(source, locations, declared));
  if (mappings.length !== 1) return null;
  return mappings[0] ?? null;
}
