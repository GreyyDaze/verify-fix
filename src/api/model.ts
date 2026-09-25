import path from "node:path";
import ts from "typescript";
import { assertionId } from "../assertion/id.ts";
import { isFalsifiable, isWeakMatcher, matcherClass } from "../assertion/classify.ts";
import type { Assertion, AssertionInventory } from "../types.ts";

export interface ApiAssertionModel {
  property: "statusCode" | "headers" | "jsonBody" | string;
  selector: string | null;
  operator: string;
  target: string | number | boolean | null;
  sourceFile: string;
  sourceLine: number;
  assertion: Assertion;
}

export interface ApiRequestModel {
  method: string;
  url: string;
  body: string | null;
  headers: Record<string, string>;
  assertions: ApiAssertionModel[];
}

export interface ApiCheckModel {
  logicalId: string;
  name: string;
  checkFile: string;
  request: ApiRequestModel;
  setupFile: string | null;
  teardownFile: string | null;
  shouldFail: boolean;
  retrySource: string | null;
  timeoutSource: string | null;
  environmentKeys: string[];
  errors: string[];
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface ModuleInfo {
  file: string;
  source: string;
  sf: ts.SourceFile;
  imports: Map<string, { file: string; imported: string }>;
  variables: Map<string, ts.Expression>;
  exports: Map<string, ts.Expression>;
}

function norm(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function moduleCandidates(from: string, specifier: string): string[] {
  const base = norm(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
}

function propName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function buildModules(files: Map<string, string>): Map<string, ModuleInfo> {
  const normalized = new Map<string, string>();
  for (const [file, source] of files) normalized.set(norm(file), source);
  const modules = new Map<string, ModuleInfo>();
  for (const [file, source] of normalized) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const info: ModuleInfo = { file, source, sf, imports: new Map(), variables: new Map(), exports: new Map() };
    modules.set(file, info);
  }
  for (const info of modules.values()) {
    for (const statement of info.sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".")) {
        const importedFile = moduleCandidates(info.file, statement.moduleSpecifier.text).find((candidate) => modules.has(candidate));
        if (!importedFile || !statement.importClause) continue;
        const clause = statement.importClause;
        if (clause.name) info.imports.set(clause.name.text, { file: importedFile, imported: "default" });
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            info.imports.set(element.name.text, { file: importedFile, imported: element.propertyName?.text ?? element.name.text });
          }
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          info.imports.set(clause.namedBindings.name.text, { file: importedFile, imported: "*" });
        }
      }
      if (ts.isVariableStatement(statement)) {
        const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          info.variables.set(declaration.name.text, declaration.initializer);
          if (exported) info.exports.set(declaration.name.text, declaration.initializer);
        }
      }
      if (ts.isExportAssignment(statement)) info.exports.set("default", statement.expression);
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const local = element.propertyName?.text ?? element.name.text;
          const value = info.variables.get(local);
          if (value) info.exports.set(element.name.text, value);
        }
      }
    }
  }
  return modules;
}

interface ResolvedExpression {
  expression: ts.Expression;
  module: ModuleInfo;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let value = expression;
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isTypeAssertionExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
  return value;
}

function resolveExpression(expression: ts.Expression, module: ModuleInfo, modules: Map<string, ModuleInfo>, seen = new Set<string>()): ResolvedExpression | null {
  const value = unwrap(expression);
  if (!ts.isIdentifier(value)) return { expression: value, module };
  const marker = `${module.file}:${value.text}`;
  if (seen.has(marker)) return null;
  seen.add(marker);
  const local = module.variables.get(value.text);
  if (local) return resolveExpression(local, module, modules, seen);
  const imported = module.imports.get(value.text);
  if (!imported || imported.imported === "*") return null;
  const targetModule = modules.get(imported.file);
  const targetExpression = targetModule?.exports.get(imported.imported) ?? targetModule?.variables.get(imported.imported);
  if (!targetModule || !targetExpression) return null;
  return resolveExpression(targetExpression, targetModule, modules, seen);
}

function staticValue(expression: ts.Expression, module: ModuleInfo, modules: Map<string, ModuleInfo>, seen = new Set<string>()): JsonValue | undefined {
  const resolved = resolveExpression(expression, module, modules, new Set(seen));
  if (!resolved) return undefined;
  const value = unwrap(resolved.expression);
  const owner = resolved.module;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) {
    const number = Number(value.operand.text);
    return value.operator === ts.SyntaxKind.MinusToken ? -number : number;
  }
  if (ts.isTemplateExpression(value)) {
    let text = value.head.text;
    for (const span of value.templateSpans) {
      const part = staticValue(span.expression, owner, modules, seen);
      if (typeof part !== "string" && typeof part !== "number" && typeof part !== "boolean") return undefined;
      text += String(part) + span.literal.text;
    }
    return text;
  }
  if (ts.isArrayLiteralExpression(value)) {
    const out: JsonValue[] = [];
    for (const element of value.elements) {
      if (ts.isSpreadElement(element)) return undefined;
      const item = staticValue(element, owner, modules, seen);
      if (item === undefined) return undefined;
      out.push(item);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(value)) {
    const out: { [key: string]: JsonValue } = {};
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
      const name = propName(property.name);
      if (!name) return undefined;
      const expressionValue = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
      const item = staticValue(expressionValue, owner, modules, seen);
      if (item === undefined) return undefined;
      out[name] = item;
    }
    return out;
  }
  if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.expression.getText(owner.sf) === "JSON" && value.expression.name.text === "stringify" && value.arguments[0]) {
    const item = staticValue(value.arguments[0], owner, modules, seen);
    return item === undefined ? undefined : JSON.stringify(item);
  }
  if (ts.isPropertyAccessExpression(value)) {
    if (ts.isIdentifier(value.expression)) {
      const imported = owner.imports.get(value.expression.text);
      if (imported?.imported === "*") {
        const targetModule = modules.get(imported.file);
        const target = targetModule?.exports.get(value.name.text) ?? targetModule?.variables.get(value.name.text);
        if (targetModule && target) return staticValue(target, targetModule, modules, seen);
      }
    }
    const object = staticValue(value.expression, owner, modules, seen);
    if (object && !Array.isArray(object) && typeof object === "object") return object[value.name.text];
  }
  return undefined;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propName(property.name) === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
  return null;
}

function resolveObject(expression: ts.Expression | null, module: ModuleInfo, modules: Map<string, ModuleInfo>): { object: ts.ObjectLiteralExpression; module: ModuleInfo } | null {
  if (!expression) return null;
  const resolved = resolveExpression(expression, module, modules);
  if (!resolved) return null;
  const value = unwrap(resolved.expression);
  return ts.isObjectLiteralExpression(value) ? { object: value, module: resolved.module } : null;
}

function sourceLine(module: ModuleInfo, node: ts.Node): number {
  return module.sf.getLineAndCharacterOfPosition(node.getStart(module.sf)).line + 1;
}

function literalText(value: JsonValue): string {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
}

function parseAssertion(expression: ts.Expression, module: ModuleInfo, modules: Map<string, ModuleInfo>, errors: string[]): ApiAssertionModel | null {
  const resolved = resolveExpression(expression, module, modules);
  if (!resolved) {
    errors.push(`cannot safely resolve assertion expression in ${module.file}:${sourceLine(module, expression)}`);
    return null;
  }
  const call = unwrap(resolved.expression);
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) {
    errors.push(`unsupported assertion expression in ${resolved.module.file}:${sourceLine(resolved.module, call)}`);
    return null;
  }
  const operator = call.expression.name.text;
  const builderCall = unwrap(call.expression.expression);
  if (!ts.isCallExpression(builderCall) || !ts.isPropertyAccessExpression(builderCall.expression) || builderCall.expression.expression.getText(resolved.module.sf) !== "AssertionBuilder") {
    errors.push(`assertion is not a supported AssertionBuilder call in ${resolved.module.file}:${sourceLine(resolved.module, call)}`);
    return null;
  }
  const property = builderCall.expression.name.text;
  const selectorValue = builderCall.arguments[0] ? staticValue(builderCall.arguments[0], resolved.module, modules) : null;
  const targetValue = call.arguments[0] ? staticValue(call.arguments[0], resolved.module, modules) : undefined;
  if (selectorValue !== null && typeof selectorValue !== "string") {
    errors.push(`AssertionBuilder.${property} selector is not a static string in ${resolved.module.file}:${sourceLine(resolved.module, call)}`);
    return null;
  }
  if (targetValue === undefined || (typeof targetValue === "object" && targetValue !== null)) {
    errors.push(`AssertionBuilder.${property}.${operator} target is not a static primitive in ${resolved.module.file}:${sourceLine(resolved.module, call)}`);
    return null;
  }
  const selector = selectorValue as string | null;
  const subject = selector === null ? `${property}()` : `${property}(${JSON.stringify(selector)})`;
  const target = literalText(targetValue);
  const cls = matcherClass(operator);
  const weak = isWeakMatcher(operator);
  const assertion: Assertion = {
    id: assertionId(subject, operator, target),
    subject,
    matcher: operator,
    target,
    kind: cls.kind,
    onCriticalPath: true,
    sourceLine: sourceLine(resolved.module, call),
    falsifiable: isFalsifiable(operator, target) && !weak,
    guarded: false,
  };
  return { property, selector, operator, target: targetValue, sourceFile: resolved.module.file, sourceLine: assertion.sourceLine, assertion };
}

function parseAssertions(expression: ts.Expression | null, module: ModuleInfo, modules: Map<string, ModuleInfo>, errors: string[]): ApiAssertionModel[] {
  if (!expression) {
    errors.push(`API check request has no assertions in ${module.file}`);
    return [];
  }
  const resolved = resolveExpression(expression, module, modules);
  if (!resolved) {
    errors.push(`cannot safely resolve assertions in ${module.file}`);
    return [];
  }
  const value = unwrap(resolved.expression);
  if (!ts.isArrayLiteralExpression(value)) {
    errors.push(`assertions must resolve to a static array in ${resolved.module.file}`);
    return [];
  }
  const out: ApiAssertionModel[] = [];
  for (const element of value.elements) {
    if (ts.isSpreadElement(element)) {
      const spread = resolveExpression(element.expression, resolved.module, modules);
      const spreadValue = spread ? unwrap(spread.expression) : null;
      if (!spread || !spreadValue || !ts.isArrayLiteralExpression(spreadValue)) {
        errors.push(`cannot safely resolve spread assertions in ${resolved.module.file}:${sourceLine(resolved.module, element)}`);
        continue;
      }
      for (const nested of spreadValue.elements) {
        const assertion = parseAssertion(nested as ts.Expression, spread.module, modules, errors);
        if (assertion) out.push(assertion);
      }
      continue;
    }
    const assertion = parseAssertion(element as ts.Expression, resolved.module, modules, errors);
    if (assertion) out.push(assertion);
  }
  return out;
}

function staticString(expression: ts.Expression | null, module: ModuleInfo, modules: Map<string, ModuleInfo>): string | null {
  if (!expression) return null;
  const value = staticValue(expression, module, modules);
  return typeof value === "string" ? value : null;
}

function entrypoint(expression: ts.Expression | null, module: ModuleInfo, modules: Map<string, ModuleInfo>): string | null {
  const object = resolveObject(expression, module, modules);
  if (!object) return null;
  const value = objectProperty(object.object, "entrypoint");
  if (!value) return null;
  const direct = staticString(value, object.module, modules);
  if (direct) return norm(path.posix.join(path.posix.dirname(module.file), direct));
  const unwrapped = unwrap(value);
  if (ts.isCallExpression(unwrapped) && ts.isPropertyAccessExpression(unwrapped.expression) && unwrapped.expression.name.text === "join") {
    const last = unwrapped.arguments.at(-1);
    const file = last ? staticValue(last, object.module, modules) : undefined;
    if (typeof file === "string") return norm(path.posix.join(path.posix.dirname(module.file), file));
  }
  return null;
}

function environmentKeys(expression: ts.Expression | null, module: ModuleInfo, modules: Map<string, ModuleInfo>): string[] {
  if (!expression) return [];
  const resolved = resolveExpression(expression, module, modules);
  if (!resolved) return [];
  const value = unwrap(resolved.expression);
  if (!ts.isArrayLiteralExpression(value)) return [];
  const keys: string[] = [];
  for (const element of value.elements) {
    const item = resolveObject(element as ts.Expression, resolved.module, modules);
    const key = item ? staticString(objectProperty(item.object, "key"), item.module, modules) : null;
    if (key) keys.push(key);
  }
  return keys;
}

export function parseApiCheckProject(checkFile: string, files: Map<string, string>, wantedLogicalId?: string | null): ApiCheckModel | null {
  const modules = buildModules(files);
  const preferred = modules.get(norm(checkFile));
  const ordered = preferred ? [preferred, ...[...modules.values()].filter((module) => module !== preferred)] : [...modules.values()];
  let selected: { module: ModuleInfo; call: ts.NewExpression } | null = null;
  for (const module of ordered) {
    const visit = (node: ts.Node): void => {
      if (selected) return;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "ApiCheck") {
        const id = node.arguments?.[0] ? staticValue(node.arguments[0], module, modules) : undefined;
        if (!wantedLogicalId || id === wantedLogicalId) selected = { module, call: node };
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sf);
    if (selected) break;
  }
  const chosen = selected as { module: ModuleInfo; call: ts.NewExpression } | null;
  if (!chosen && wantedLogicalId) return parseApiCheckProject(checkFile, files, null);
  if (!chosen) return null;

  const module = chosen.module;
  const call = chosen.call;
  const errors: string[] = [];
  const logicalId = call.arguments?.[0] ? staticValue(call.arguments[0], module, modules) : undefined;
  const options = call.arguments?.[1] ? resolveObject(call.arguments[1], module, modules) : null;
  if (typeof logicalId !== "string") errors.push(`ApiCheck logical ID is not a static string in ${module.file}`);
  if (!options) errors.push(`ApiCheck options are not a static object in ${module.file}`);
  if (options?.object.properties.some((property) => ts.isSpreadAssignment(property))) errors.push(`ApiCheck options contain an unresolved object spread in ${options.module.file}`);
  const opts = options?.object;
  const owner = options?.module ?? module;
  const name = opts ? staticString(objectProperty(opts, "name"), owner, modules) : null;
  const requestObject = opts ? resolveObject(objectProperty(opts, "request"), owner, modules) : null;
  if (!requestObject) errors.push(`ApiCheck request is not a static object in ${module.file}`);
  if (requestObject?.object.properties.some((property) => ts.isSpreadAssignment(property))) errors.push(`ApiCheck request contains an unresolved object spread in ${requestObject.module.file}`);
  const request = requestObject?.object;
  const requestOwner = requestObject?.module ?? owner;
  const method = request ? staticString(objectProperty(request, "method"), requestOwner, modules) : null;
  const url = request ? staticString(objectProperty(request, "url"), requestOwner, modules) : null;
  if (!method) errors.push(`API request method is not a static string in ${module.file}`);
  if (!url) errors.push(`API request URL is not a static string in ${module.file}`);
  const body = request ? staticString(objectProperty(request, "body"), requestOwner, modules) : null;
  const headerValue = request ? staticValue(objectProperty(request, "headers") ?? ts.factory.createObjectLiteralExpression(), requestOwner, modules) : {};
  const headers: Record<string, string> = {};
  if (headerValue && typeof headerValue === "object" && !Array.isArray(headerValue)) {
    for (const [key, value] of Object.entries(headerValue)) if (typeof value === "string") headers[key] = value;
  }
  const assertions = parseAssertions(request ? objectProperty(request, "assertions") : null, requestOwner, modules, errors);
  const shouldFailValue = opts ? staticValue(objectProperty(opts, "shouldFail") ?? ts.factory.createFalse(), owner, modules) : false;
  const retryExpr = opts ? objectProperty(opts, "retryStrategy") ?? objectProperty(opts, "retry") : null;
  const timeoutExpr = opts ? objectProperty(opts, "maxResponseTime") ?? objectProperty(opts, "timeout") : null;
  return {
    logicalId: typeof logicalId === "string" ? logicalId : "",
    name: name ?? "",
    checkFile: module.file,
    request: { method: method ?? "", url: url ?? "", body, headers, assertions },
    setupFile: opts ? entrypoint(objectProperty(opts, "setupScript"), owner, modules) : null,
    teardownFile: opts ? entrypoint(objectProperty(opts, "tearDownScript") ?? objectProperty(opts, "teardownScript"), owner, modules) : null,
    shouldFail: shouldFailValue === true,
    retrySource: retryExpr ? retryExpr.getText(owner.sf) : null,
    timeoutSource: timeoutExpr ? timeoutExpr.getText(owner.sf) : null,
    environmentKeys: opts ? environmentKeys(objectProperty(opts, "environmentVariables"), owner, modules) : [],
    errors,
  };
}

export function apiInventory(model: ApiCheckModel): AssertionInventory {
  return {
    checkFile: model.checkFile,
    assertions: model.request.assertions.map((entry) => entry.assertion),
    steps: [`request.${model.request.method.toLowerCase()}:1`],
    totalAssertions: model.request.assertions.length,
  };
}
