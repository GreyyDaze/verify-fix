// Multistep source modeling — the static half of trusted MultiStepCheck
// support. Parses the construct identity (logical ID, entrypoint, scheduling)
// and the transaction script (ordered awaited test.step() calls, the real
// request methods of the canonical transaction, ENVIRONMENT_URL origin usage,
// headers, JSON bodies, and exact assertions with their step context).
//
// Assertion identity stays byte-stable: ids come from the SAME
// scanExpectCalls + normalizeSubject + assertionId pipeline the shared
// inventory uses, so this module never invents a second identity. Multistep
// step context (which step an assertion lives in, whether it is awaited) is
// carried SEPARATELY, on this model — never inside the assertion id.
//
// Parsing is deterministic and AI-free. Anything unsupported (unresolved
// import/constant, unsupported matcher, non-literal step title, unsupported
// syntax) is recorded in `errors` and maps to UNCERTAIN downstream — never
// approximated.

import path from "node:path";
import ts from "typescript";
import { assertionId, normalizeSubject } from "../assertion/id.ts";
import { isKnownMatcher } from "../assertion/classify.ts";
import { scanExpectCalls, stripComments } from "../assertion/inventory.ts";

export interface MultiStepConstructModel {
  logicalId: string | null;
  name: string | null;
  /** entrypoint script path resolved against the construct file (normalized) */
  entrypoint: string | null;
  frequencyMinutes: number | null;
  locations: string[];
  runParallel: boolean | null;
  environmentKeys: string[];
  errors: string[];
}

export interface MultiStepStepModel {
  title: string;
  index: number;
  line: number;
  /** false = `test.step(...)` without `await` — definite FAILED downstream */
  awaited: boolean;
  /** true when the step call sits under a conditional/loop — bypass vector */
  conditional: boolean;
}

export interface MultiStepRequestModel {
  stepTitle: string | null;
  method: string;
  /** raw URL template text, e.g. `${origin}/api/login` */
  urlTemplate: string;
  headerKeys: string[];
  bodyKeys: string[];
  usesBearer: boolean;
  line: number;
}

export interface MultiStepAssertionModel {
  /** the enclosing test.step title, or null when outside any step */
  stepTitle: string | null;
  id: string;
  subject: string;
  matcher: string;
  target: string;
  sourceLine: number;
}

export interface MultiStepScriptModel {
  file: string;
  steps: MultiStepStepModel[];
  requests: MultiStepRequestModel[];
  assertions: MultiStepAssertionModel[];
  readsEnvironmentUrl: boolean;
  environmentUrlFallback: boolean;
  hardcodedHosts: string[];
  /** policy markers found (skip/soft/catch/rewrite/…) — FAILED downstream */
  banned: string[];
  /** unsupported/unresolved constructs — UNCERTAIN downstream */
  errors: string[];
}

export interface MultiStepSourceModel {
  construct: MultiStepConstructModel | null;
  script: MultiStepScriptModel | null;
  errors: string[];
}

function norm(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sourceLine(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function literalString(node: ts.Expression | null | undefined): string | null {
  if (!node) return null;
  const v = node;
  if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return v.text;
  return null;
}

function propName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propName(property.name) === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
  return null;
}

function stringArrayLiteral(node: ts.Expression | null | undefined): string[] | null {
  if (!node || !ts.isArrayLiteralExpression(node)) return null;
  const out: string[] = [];
  for (const element of node.elements) {
    const value = literalString(element as ts.Expression);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

/** Frequency.EVERY_5M → 5; a plain numeric literal → that number. */
function frequencyMinutes(node: ts.Expression | null | undefined): number | null {
  if (!node) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  const text = node.getText();
  const m = /EVERY_(\d+)([MH])/.exec(text);
  if (m) {
    const n = Number(m[1]);
    return m[2] === "H" ? n * 60 : n;
  }
  return null;
}

function findMultiStepConstruct(files: Map<string, string>): { file: string; node: ts.NewExpression; sf: ts.SourceFile } | null {
  const ordered = [...files.keys()].map(norm).sort();
  const byKey = new Map<string, string>();
  for (const key of files.keys()) byKey.set(norm(key), key);
  for (const file of ordered) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = files.get(byKey.get(file) ?? file);
    if (source === undefined || !source.includes("new MultiStepCheck(")) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let found: ts.NewExpression | null = null;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "MultiStepCheck") found = node;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (found) return { file, node: found, sf };
  }
  return null;
}

export function parseMultiStepConstruct(files: Map<string, string>): { model: MultiStepConstructModel; constructFile: string } | null {
  const hit = findMultiStepConstruct(files);
  if (!hit) return null;
  const errors: string[] = [];
  const rawId = hit.node.arguments?.[0];
  const logicalId = literalString(rawId);
  if (logicalId === null) errors.push(`MultiStepCheck logical ID is not a static string in ${hit.file}`);
  const options = hit.node.arguments?.[1];
  if (!options || !ts.isObjectLiteralExpression(options)) {
    errors.push(`MultiStepCheck options are not a static object in ${hit.file}`);
    return { model: { logicalId, name: null, entrypoint: null, frequencyMinutes: null, locations: [], runParallel: null, environmentKeys: [], errors }, constructFile: hit.file };
  }
  const name = literalString(objectProperty(options, "name"));
  const locations = stringArrayLiteral(objectProperty(options, "locations")) ?? [];
  const runParallelExpr = objectProperty(options, "runParallel");
  const runParallel = runParallelExpr && (runParallelExpr.kind === ts.SyntaxKind.TrueKeyword || runParallelExpr.kind === ts.SyntaxKind.FalseKeyword) ? runParallelExpr.kind === ts.SyntaxKind.TrueKeyword : null;
  const environmentKeys: string[] = [];
  const envExpr = objectProperty(options, "environmentVariables");
  if (envExpr && ts.isArrayLiteralExpression(envExpr)) {
    for (const element of envExpr.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const key = literalString(objectProperty(element, "key"));
      if (key) environmentKeys.push(key);
    }
  }
  // entrypoint: path.join(__dirname, "x.spec.ts") or a plain relative string
  let entrypoint: string | null = null;
  const code = objectProperty(options, "code");
  const entryExpr = code && ts.isObjectLiteralExpression(code) ? objectProperty(code, "entrypoint") : null;
  if (entryExpr) {
    const direct = literalString(entryExpr);
    if (direct !== null) entrypoint = norm(path.posix.join(path.posix.dirname(hit.file), direct));
    else if (ts.isCallExpression(entryExpr) && ts.isPropertyAccessExpression(entryExpr.expression) && entryExpr.expression.name.text === "join") {
      const last = entryExpr.arguments.at(-1);
      const file = literalString(last as ts.Expression);
      if (file !== null) entrypoint = norm(path.posix.join(path.posix.dirname(hit.file), file));
    }
    if (!entrypoint) errors.push(`MultiStepCheck code.entrypoint does not statically resolve in ${hit.file}`);
  } else {
    errors.push(`MultiStepCheck has no code.entrypoint in ${hit.file}`);
  }
  return {
    model: { logicalId, name, entrypoint, frequencyMinutes: frequencyMinutes(objectProperty(options, "frequency")), locations, runParallel, environmentKeys, errors },
    constructFile: hit.file,
  };
}

interface StepSpan {
  step: MultiStepStepModel;
  startLine: number;
  endLine: number;
}

function isConditionalContext(node: ts.Node, stopAt: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current && current !== stopAt) {
    if (
      ts.isIfStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isCaseClause(current) ||
      ts.isCatchClause(current) ||
      ts.isTryStatement(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function declaredIdentifiers(sf: ts.SourceFile): Set<string> {
  const declared = new Set<string>();
  const add = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) declared.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) add(element.name);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declared.add(node.name.text);
    else if (ts.isFunctionDeclaration(node) && node.name) declared.add(node.name.text);
    else if (ts.isParameter(node)) add(node.name);
    else if (ts.isImportClause(node) && node.name) declared.add(node.name.text);
    else if (ts.isImportSpecifier(node)) declared.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return declared;
}

const REQUEST_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Receivers that make a `.<method>()` call request-shaped but unmodeled. */
const REQUEST_SHAPED_RECEIVERS = new Set(["page", "context", "http", "https", "axios", "client", "api", "req", "requestApi", "apiClient", "fetchApi"]);

interface ConstInfo {
  init: ts.Expression | null;
  exported: boolean;
}

function constMapOf(sf: ts.SourceFile): Map<string, ConstInfo> {
  const map = new Map<string, ConstInfo>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      const exported = (node.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) map.set(decl.name.text, { init: decl.initializer ?? null, exported });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

interface ResolvedConst {
  value: string | number | boolean | null;
  provable: boolean;
}

const UNRESOLVED: ResolvedConst = { value: null, provable: false };

/** Statically resolve a const initializer: literals only, identifier chains bounded. */
function resolveConstExpr(expr: ts.Expression | null | undefined, consts: Map<string, ConstInfo>, depth: number, seen: Set<string>): ResolvedConst {
  if (!expr || depth > 4) return UNRESOLVED;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { value: expr.text, provable: true };
  if (ts.isNumericLiteral(expr)) return { value: Number(expr.text), provable: true };
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { value: true, provable: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { value: false, provable: true };
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { value: null, provable: true };
  if (ts.isIdentifier(expr)) {
    if (seen.has(expr.text)) return UNRESOLVED;
    seen.add(expr.text);
    const info = consts.get(expr.text);
    if (!info) return UNRESOLVED;
    return resolveConstExpr(info.init, consts, depth + 1, seen);
  }
  return UNRESOLVED;
}

interface ImportedBinding {
  /** kind "const" carries a statically provable (or non-provable) value; "other" is an unresolved callable */
  kind: "const" | "other";
  resolved: ResolvedConst;
  /** true when the imported const statically derives from process.env.ENVIRONMENT_URL */
  derived: boolean;
}

/**
 * True when an expression provably derives from `process.env.ENVIRONMENT_URL`
 * with no fallback: the direct env access, an identifier chain to it, or a
 * call whose arguments include it (validation wrappers like
 * requireHttpsOrigin(rawEnvironmentUrl, …)). Depth is bounded; cycles fail.
 */
function exprDerivesEnv(
  expr: ts.Expression | null | undefined,
  localConsts: Map<string, ConstInfo>,
  localBindings: Map<string, ImportedBinding>,
  depth: number,
  seen: Set<string>,
): boolean {
  if (!expr || depth > 6) return false;
  if (ts.isPropertyAccessExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const envAccess = expr.expression;
    return ts.isIdentifier(envAccess.expression)
      && envAccess.expression.text === "process"
      && envAccess.name.text === "env"
      && expr.name.text === "ENVIRONMENT_URL";
  }
  if (ts.isIdentifier(expr)) {
    if (seen.has(expr.text)) return false;
    seen.add(expr.text);
    const info = localConsts.get(expr.text);
    if (info) return exprDerivesEnv(info.init, localConsts, localBindings, depth + 1, seen);
    const binding = localBindings.get(expr.text);
    return binding !== undefined && binding.kind === "const" && binding.derived;
  }
  if (ts.isCallExpression(expr)) {
    return expr.arguments.some((argument) => exprDerivesEnv(argument, localConsts, localBindings, depth + 1, seen));
  }
  return false;
}

/**
 * Bounded depth-first scan of RELATIVE imports from the entry file.
 * - unresolved local modules → errors (UNCERTAIN)
 * - exported const values resolve (including identifier chains)
 * - any other imported binding is an "other" binding: invoking it is an
 *   unknown helper → UNCERTAIN
 * Bounds: ≤ 32 files, import depth ≤ 8, const chain depth ≤ 4.
 */
function scanLocalImports(
  entryFile: string,
  entrySource: string,
  projectFiles: Map<string, string>,
  errors: string[],
): Map<string, ImportedBinding> {
  const bindings = new Map<string, ImportedBinding>();
  const fileByNorm = new Map<string, string>();
  for (const key of projectFiles.keys()) fileByNorm.set(norm(key), key);
  const parsedConsts = new Map<string, Map<string, ConstInfo>>();
  const seenFiles = new Set<string>();
  let fileCount = 0;

  const resolveModule = (fromFile: string, spec: string): string | null => {
    const base = norm(path.posix.join(path.posix.dirname(fromFile), spec));
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}/index.ts`];
    for (const candidate of candidates) {
      const key = fileByNorm.get(candidate);
      if (key !== undefined && /\.[cm]?[jt]sx?$/.test(candidate)) return key;
    }
    return null;
  };

  const walk = (file: string, source: string, depth: number): void => {
    const fileKey = norm(file);
    if (seenFiles.has(fileKey)) return;
    if (depth > 8) {
      errors.push(`local import graph in ${file} exceeds the supported depth bound — unresolved imports are UNCERTAIN`);
      return;
    }
    if (fileCount >= 32) {
      errors.push(`local import graph exceeds the 32-file bound at ${file} — unresolved imports are UNCERTAIN`);
      return;
    }
    seenFiles.add(fileKey);
    fileCount += 1;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const consts = constMapOf(sf);
    parsedConsts.set(fileKey, consts);
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const spec = statement.moduleSpecifier.text;
      const isRelative = spec.startsWith("./") || spec.startsWith("../") || spec.startsWith(".\\") || spec.startsWith("..\\");
      if (!isRelative) continue; // bare imports are validated by the caller
      const target = resolveModule(file, spec);
      if (target === null) {
        errors.push(`unresolved local import \"${spec}\" in ${file} — unresolved imports are UNCERTAIN`);
        continue;
      }
      const clause = statement.importClause;
      if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.name || clause.namedBindings.elements.length === 0) {
        errors.push(`unsupported local import form \"${spec}\" in ${file} — only named imports of static consts are supported (UNCERTAIN)`);
        continue;
      }
      const targetKey = norm(target);
      if (!seenFiles.has(targetKey)) {
        const targetSource = projectFiles.get(target);
        if (targetSource === undefined) {
          errors.push(`unresolved local import \"${spec}\" in ${file} — unresolved imports are UNCERTAIN`);
          continue;
        }
        walk(target, targetSource, depth + 1);
      }
      const targetConsts = parsedConsts.get(targetKey);
      for (const element of clause.namedBindings.elements) {
        const localName = element.name.text;
        const importedName = (element.propertyName ?? element.name).text;
        const info = targetConsts?.get(importedName);
        if (info && info.exported) {
          const resolved = resolveConstExpr(info.init, targetConsts!, 0, new Set());
          const derived = info.init ? exprDerivesEnv(info.init, targetConsts!, new Map(), 0, new Set()) : false;
          bindings.set(localName, { kind: "const", resolved, derived });
        } else {
          bindings.set(localName, { kind: "other", resolved: UNRESOLVED, derived: false });
        }
      }
    }
  };
  walk(entryFile, entrySource, 0);
  return bindings;
}

/** Keywords and standard globals that can root an expression without a local declaration. */
const KEYWORD_OR_GLOBAL_ROOTS = new Set([
  "typeof", "void", "delete", "new", "instanceof", "in", "of", "await", "yield",
  "true", "false", "null", "undefined", "this", "super",
  "Number", "String", "Boolean", "Array", "Object", "JSON", "Math", "Date", "RegExp",
  "Set", "Map", "WeakMap", "WeakSet", "Promise", "Error", "URL", "URLSearchParams",
  "BigInt", "Symbol", "parseInt", "parseFloat", "isNaN", "isFinite",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "process", "console", "globalThis", "structuredClone", "Reflect", "Proxy",
]);

function headerAndBodyKeys(call: ts.CallExpression, sf: ts.SourceFile): { headerKeys: string[]; bodyKeys: string[]; usesBearer: boolean } {
  const headerKeys: string[] = [];
  const bodyKeys: string[] = [];
  let usesBearer = false;
  const options = call.arguments[1];
  if (options && ts.isObjectLiteralExpression(options)) {
    const headers = objectProperty(options, "headers");
    if (headers && ts.isObjectLiteralExpression(headers)) {
      for (const property of headers.properties) {
        const name = propName(property.name);
        if (name) headerKeys.push(name);
        const value = ts.isPropertyAssignment(property) ? property.initializer.getText(sf) : "";
        if (/Bearer\s/.test(value)) usesBearer = true;
      }
    }
    const data = objectProperty(options, "data");
    if (data && ts.isObjectLiteralExpression(data)) {
      for (const property of data.properties) {
        const name = propName(property.name);
        if (name) bodyKeys.push(name);
      }
    }
  }
  return { headerKeys, bodyKeys, usesBearer };
}

const BANNED_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "soft assertion (expect.soft/expect.poll)", re: /expect\.\s*(soft|poll)\b/ },
  { label: "test.skip/fixme/only", re: /\btest\.\s*(skip|fixme|only)\b/ },
  { label: "catch/ignore suppression", re: /\.catch\s*\(|\bcatch\s*\{/ },
  { label: "shouldFail", re: /\bshouldFail\b/ },
  { label: "response rewriting (route/fulfill/setResponse)", re: /\broute\s*\(|\.\s*fulfill\s*\(|\bsetResponse\s*\(/ },
  { label: "timeout/slow used as repair", re: /\btest\.\s*(setTimeout|slow)\s*\(/ },
  { label: "retries in code", re: /\bretries\s*:/ },
  // A fabricated token is a non-empty string literal assigned to the bearer —
  // `bearerToken = ''` is only the runtime-memory initialization, not a token.
  { label: "fabricated token literal", re: /\b(bearerToken|token)\s*=\s*['"`](?!['"`])/ },
];

const HOST_LITERAL = /["'`]https?:\/\/[^"'`]*["'`]/g;

export function parseMultiStepScript(file: string, source: string, projectFiles?: Map<string, string>): MultiStepScriptModel {
  const errors: string[] = [];
  const banned: string[] = [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.(?:tsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const declared = declaredIdentifiers(sf);
  const clean = stripComments(source);
  const lines = source.split(/\r?\n/);
  const cleanLines = clean.split(/\r?\n/);

  // ---- imports: node:/@playwright/test resolve bare; relative imports resolve
  // through the project files with bounded static const resolution ----
  const localBindings: Map<string, ImportedBinding> = projectFiles ? scanLocalImports(file, source, projectFiles, errors) : new Map();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    const isRelative = spec.startsWith("./") || spec.startsWith("../");
    if (isRelative) {
      if (!projectFiles) errors.push(`unsupported import "${spec}" in ${file} — unresolved imports are UNCERTAIN`);
      continue; // resolution problems were pushed by scanLocalImports
    }
    const ok = spec.startsWith("node:") || spec === "@playwright/test";
    if (!ok) errors.push(`unsupported import "${spec}" in ${file} — unresolved imports are UNCERTAIN`);
  }

  // ---- statically provable consts + request-fixture aliases ----
  const localConsts = constMapOf(sf);
  const requestAliases = new Set<string>();
  {
    const aliasVisit = (node: ts.Node): void => {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && ts.isIdentifier(decl.initializer) && decl.initializer.text === "request") {
            requestAliases.add(decl.name.text);
          }
        }
      }
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.propertyName && ts.isIdentifier(node.propertyName) && node.propertyName.text === "request") {
        requestAliases.add(node.name.text); // renamed fixture binding: ({ request: req })
      }
      ts.forEachChild(node, aliasVisit);
    };
    aliasVisit(sf);
  }
  const resolveTitleExpr = (expr: ts.Expression | null | undefined): string | null => {
    if (!expr) return null;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isIdentifier(expr)) {
      const info = localConsts.get(expr.text);
      if (info) {
        const resolved = resolveConstExpr(info.init, localConsts, 0, new Set([expr.text]));
        if (resolved.provable && typeof resolved.value === "string") return resolved.value;
      }
      const binding = localBindings.get(expr.text);
      if (binding?.kind === "const" && binding.resolved.provable && typeof binding.resolved.value === "string") return binding.resolved.value;
      return null;
    }
    return null;
  };

  // ---- ordered steps ----
  const steps: MultiStepStepModel[] = [];
  const spans: StepSpan[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "step") {
      const receiver = node.expression.expression;
      const isTestStep = (ts.isIdentifier(receiver) && receiver.text === "test") || (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "test");
      if (isTestStep) {
        const title = resolveTitleExpr(node.arguments[0] as ts.Expression);
        if (title === null) {
          errors.push(`test.step title in ${file} is not a static string — unsupported syntax is UNCERTAIN`);
        } else {
          const awaited = ts.isAwaitExpression(node.parent);
          const conditional = isConditionalContext(node, sf);
          const line = sourceLine(sf, node);
          const step: MultiStepStepModel = { title, index: steps.length, line, awaited, conditional };
          steps.push(step);
          // span for step-scoped line mapping (assertions/requests inside the callback)
          const end = node.getEnd();
          const startLine = line;
          const endLine = source.slice(0, end).split(/\r?\n/).length;
          spans.push({ step, startLine, endLine });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // ---- requests: the real request methods of the canonical transaction,
  // ENVIRONMENT_URL derivation proof, and unknown-helper detection ----
  const requests: MultiStepRequestModel[] = [];
  const visitRequests = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // Unknown request helpers: bare fetch() and any invoked imported binding
      // (imported wrappers cannot be traced to a request — UNCERTAIN).
      if (ts.isIdentifier(callee) && callee.text === "fetch") {
        errors.push(`fetch() in ${file} is an unsupported request helper — helpers outside request.<method> are UNCERTAIN`);
      } else if (ts.isIdentifier(callee) && localBindings.has(callee.text)) {
        errors.push(`imported helper "${callee.text}" in ${file} is unsupported — imported wrappers/helpers must be UNCERTAIN`);
      }
      // Computed access: request["get"](...)
      if (ts.isElementAccessExpression(callee)) {
        const recv = callee.expression;
        if (ts.isIdentifier(recv) && (recv.text === "request" || requestAliases.has(recv.text))) {
          errors.push(`computed request access in ${file} is unsupported — requests must call request.<method> directly (UNCERTAIN)`);
        }
      }
      if (ts.isPropertyAccessExpression(node.expression) && REQUEST_METHODS.has(node.expression.name.text)) {
        const receiver = node.expression.expression;
        if (ts.isIdentifier(receiver) && receiver.text === "request") {
          const urlExpr = node.arguments[0] as ts.Expression;
          const url = literalString(urlExpr) ?? (ts.isTemplateExpression(urlExpr) ? urlExpr.getText(sf) : null);
          if (url === null) {
            errors.push(`request.${node.expression.name.text} URL in ${file} does not resolve statically — unsupported syntax is UNCERTAIN`);
          } else {
            const line = sourceLine(sf, node);
            // Every request URL must PROVABLY derive from process.env.ENVIRONMENT_URL:
            // template roots resolve through local consts, imported consts, and
            // validation-wrapper calls — anything else (or no derivation) is UNCERTAIN.
            if (ts.isTemplateExpression(urlExpr)) {
              const root = urlExpr.head.text === "" && urlExpr.templateSpans.length > 0 ? urlExpr.templateSpans[0].expression : null;
              const derived = exprDerivesEnv(root, localConsts, localBindings, 0, new Set());
              if (!derived) {
                errors.push(`request URL at ${file}:${line} does not statically derive from process.env.ENVIRONMENT_URL — origin provenance without a fallback is UNCERTAIN`);
              }
            }
            const span = spans.find((s) => line >= s.startLine && line <= s.endLine);
            const { headerKeys, bodyKeys, usesBearer } = headerAndBodyKeys(node, sf);
            requests.push({ stepTitle: span?.step.title ?? null, method: node.expression.name.text.toUpperCase(), urlTemplate: url, headerKeys, bodyKeys, usesBearer, line });
          }
        } else if (ts.isIdentifier(receiver) && requestAliases.has(receiver.text)) {
          errors.push(`request alias "${receiver.text}" in ${file} is unsupported — requests must call request.<method> directly (UNCERTAIN)`);
        } else if ((ts.isPropertyAccessExpression(receiver) && receiver.name.text === "request")
          || (ts.isIdentifier(receiver) && REQUEST_SHAPED_RECEIVERS.has(receiver.text))) {
          errors.push(`request-capable receiver "${receiver.getText(sf)}" in ${file} is unsupported — only the request fixture is modeled (UNCERTAIN)`);
        }
      }
    }
    ts.forEachChild(node, visitRequests);
  };
  visitRequests(sf);

  // ---- assertions: line-based scan for BYTE-STABLE identity parity with parseInventory ----
  const assertions: MultiStepAssertionModel[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    for (const call of scanExpectCalls(cleanLines[i] ?? "")) {
      const subject = normalizeSubject(call.subject);
      const matcher = call.matcher;
      const target = normalizeSubject(call.target);
      if (!isKnownMatcher(matcher)) {
        errors.push(`unsupported matcher "${matcher}" at ${file}:${lineNumber} — unsupported matchers are UNCERTAIN`);
      }
      const span = spans.find((s) => lineNumber >= s.startLine && lineNumber <= s.endLine);
      // root identifier of the subject/target must resolve to something declared
      for (const expr of [subject, target]) {
        const root = /^[A-Za-z_$][\w$]*/.exec(expr)?.[0];
        if (!root) continue;
        if (declared.has(root)) continue;
        if (KEYWORD_OR_GLOBAL_ROOTS.has(root)) continue;
        errors.push(`unresolved expression "${root}" at ${file}:${lineNumber} — unresolved expressions are UNCERTAIN`);
      }
      const compat = /\?\?|\|\|/.test(target) || /\?\?|\|\|/.test(subject);
      if (compat) banned.push(`compatibility repair in assertion target at ${file}:${lineNumber}`);
      assertions.push({ stepTitle: span?.step.title ?? null, id: assertionId(subject, matcher, target), subject, matcher, target, sourceLine: lineNumber });
    }
  }

  // ---- multiline expect() calls: AST extraction (the line scan above can
  // only see single-line calls; identity still flows through the SAME
  // normalizeSubject + assertionId pipeline, so ids stay byte-stable) ----
  {
    const visitAsserts = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const chain = node.expression.expression;
        const isExpect = ts.isCallExpression(chain) && ts.isIdentifier(chain.expression) && chain.expression.text === "expect";
        if (isExpect) {
          const startLine = sourceLine(sf, node);
          const endLine = source.slice(0, node.getEnd()).split(/\r?\n/).length;
          if (startLine !== endLine) {
            // AST extraction: the argument EXPRESSIONS (no trailing commas, no
            // line assumptions) flow through the same stripComments →
            // normalizeSubject → assertionId pipeline as the line scanner, so
            // multiline identity is byte-identical to the single-line form.
            const matcher = node.expression.name.text;
            const subjectExpr = chain.arguments[0];
            const targetExpr = node.arguments[0];
            const subject = normalizeSubject(subjectExpr ? stripComments(subjectExpr.getText(sf)) : "");
            const target = normalizeSubject(targetExpr ? stripComments(targetExpr.getText(sf)) : "");
            if (!isKnownMatcher(matcher)) {
              errors.push(`unsupported matcher "${matcher}" at ${file}:${startLine} — unsupported matchers are UNCERTAIN`);
            }
            const span = spans.find((s) => startLine >= s.startLine && startLine <= s.endLine);
            for (const expr of [subject, target]) {
              const root = /^[A-Za-z_$][\w$]*/.exec(expr)?.[0];
              if (!root) continue;
              if (declared.has(root)) continue;
              if (KEYWORD_OR_GLOBAL_ROOTS.has(root)) continue;
              errors.push(`unresolved expression "${root}" at ${file}:${startLine} — unresolved expressions are UNCERTAIN`);
            }
            const compat = /\?\?|\|\|/.test(target) || /\?\?|\|\|/.test(subject);
            if (compat) banned.push(`compatibility repair in assertion target at ${file}:${startLine}`);
            assertions.push({ stepTitle: span?.step.title ?? null, id: assertionId(subject, matcher, target), subject, matcher, target, sourceLine: startLine });
          }
        }
      }
      ts.forEachChild(node, visitAsserts);
    };
    visitAsserts(sf);
  }

  // ---- ENVIRONMENT_URL origin usage ----
  const readsEnvironmentUrl = /process\.env\.ENVIRONMENT_URL\b/.test(clean);
  const environmentUrlFallback = /ENVIRONMENT_URL\s*(?:\?\?|\|\|)/.test(clean);
  if (environmentUrlFallback) banned.push("ENVIRONMENT_URL has a fallback (hardcoded-host dodge)");

  const hardcodedHosts = [...clean.matchAll(HOST_LITERAL)].map((m) => m[0].slice(1, -1));
  if (hardcodedHosts.length) banned.push(`hardcoded host in source (${hardcodedHosts[0]})`);

  for (const { label, re } of BANNED_PATTERNS) {
    if (re.test(clean)) banned.push(label);
  }

  return {
    file: norm(file),
    steps,
    requests,
    assertions,
    readsEnvironmentUrl,
    environmentUrlFallback,
    hardcodedHosts,
    banned: [...new Set(banned)],
    errors: [...new Set(errors)],
  };
}

/** Parse a complete Multistep project: construct identity + transaction script. */
export function parseMultiStepProject(files: Map<string, string>, preferredFile?: string | null): MultiStepSourceModel | null {
  const normalized = new Map<string, string>();
  for (const [key, value] of files) normalized.set(norm(key), value);
  const construct = parseMultiStepConstruct(normalized);
  if (!construct && !preferredFile) return null;
  const errors = [...(construct?.model.errors ?? [])];
  if (!construct && preferredFile) errors.push(`no MultiStepCheck construct found for ${norm(preferredFile)}`);

  // locate the entrypoint script: construct entrypoint → preferredFile → basename match
  let scriptFile: string | null = construct?.model.entrypoint ?? null;
  if (scriptFile && !normalized.has(scriptFile)) {
    const base = scriptFile.split("/").pop() ?? scriptFile;
    const match = [...normalized.keys()].find((key) => key.split("/").pop() === base);
    if (match) scriptFile = match;
  }
  if (!scriptFile && preferredFile) scriptFile = norm(preferredFile);
  if (!scriptFile && construct?.model.entrypoint === null && !preferredFile) {
    errors.push("Multistep script file could not be resolved");
  }
  const scriptSource = scriptFile ? normalized.get(scriptFile) : undefined;
  let script: MultiStepScriptModel | null = null;
  if (scriptSource === undefined) {
    errors.push(`Multistep script ${scriptFile ?? "<unresolved>"} has no source in the project files`);
  } else {
    script = parseMultiStepScript(scriptFile!, scriptSource, normalized);
    errors.push(...script.errors);
  }
  return { construct: construct?.model ?? null, script, errors: [...new Set(errors)] };
}
