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
import { stripComments } from "../assertion/inventory.ts";

export interface MultiStepConstructModel {
  logicalId: string | null;
  name: string | null;
  /** entrypoint script path resolved against the construct file (normalized) */
  entrypoint: string | null;
  frequencyMinutes: number | null;
  locations: string[];
  runParallel: boolean | null;
  activated: boolean | null;
  muted: boolean | null;
  tags: string[];
  environmentKeys: string[];
  environmentDefinitions: Array<{ key: string; value: string; secret: boolean | null }>;
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
  /** Exact modeled options expression (no unknown/spread/computed fields). */
  optionsShape: string;
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
  /** Original environment/account/slot/token bindings, including shadowing. */
  securityBindings: string[];
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
  if (ts.isNumericLiteral(node)) return Number(node.text) > 0 ? Number(node.text) : null;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Frequency") {
    const m = /^EVERY_(\d+)([MH])$/.exec(node.name.text);
    if (m) {
      const n = Number(m[1]);
      return n > 0 ? (m[2] === "H" ? n * 60 : n) : null;
    }
  }
  return null;
}

function staticProperties(node: ts.ObjectLiteralExpression, allowed: readonly string[], errors: string[], context: string): void {
  const names = new Set<string>();
  for (const property of node.properties) {
    const name = ts.isPropertyAssignment(property) ? propName(property.name) : null;
    if (!name || !allowed.includes(name) || names.has(name)) {
      errors.push(`${context} contains a duplicate, spread, computed, or unsupported property — UNCERTAIN before execution`);
    } else names.add(name);
  }
}

function findMultiStepConstruct(files: Map<string, string>): { file: string; node: ts.NewExpression; sf: ts.SourceFile; duplicates: number } | null {
  const ordered = [...files.keys()].map(norm).sort();
  const byKey = new Map<string, string>();
  for (const key of files.keys()) byKey.set(norm(key), key);
  let first: { file: string; node: ts.NewExpression; sf: ts.SourceFile } | null = null;
  let total = 0;
  for (const file of ordered) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = files.get(byKey.get(file) ?? file);
    if (source === undefined || !/\bnew\s+MultiStepCheck\s*\(/.test(source)) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "MultiStepCheck") {
        total++;
        first ??= { file, node, sf };
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const chosen = first as { file: string; node: ts.NewExpression; sf: ts.SourceFile } | null;
  return chosen ? { file: chosen.file, node: chosen.node, sf: chosen.sf, duplicates: total - 1 } : null;
}

export function parseMultiStepConstruct(files: Map<string, string>): { model: MultiStepConstructModel; constructFile: string } | null {
  const hit = findMultiStepConstruct(files);
  if (!hit) return null;
  const errors: string[] = [];
  if (hit.duplicates) errors.push("multiple MultiStepCheck constructs are ambiguous — UNCERTAIN before execution");
  const rawId = hit.node.arguments?.[0];
  const logicalId = literalString(rawId);
  if (logicalId === null) errors.push(`MultiStepCheck logical ID is not a static string in ${hit.file}`);
  const options = hit.node.arguments?.[1];
  if (!options || !ts.isObjectLiteralExpression(options)) {
    errors.push(`MultiStepCheck options are not a static object in ${hit.file}`);
    return { model: { logicalId, name: null, entrypoint: null, frequencyMinutes: null, locations: [], runParallel: null, activated: null, muted: null, tags: [], environmentKeys: [], environmentDefinitions: [], errors }, constructFile: hit.file };
  }
  staticProperties(options, ["name", "activated", "muted", "frequency", "locations", "runParallel", "tags", "environmentVariables", "code"], errors, "MultiStepCheck options");
  const name = literalString(objectProperty(options, "name"));
  const rawLocations = stringArrayLiteral(objectProperty(options, "locations"));
  const locations = rawLocations ?? [];
  const tags = stringArrayLiteral(objectProperty(options, "tags")) ?? [];
  const bool = (key: string): boolean | null => {
    const value = objectProperty(options, key);
    return value?.kind === ts.SyntaxKind.TrueKeyword ? true : value?.kind === ts.SyntaxKind.FalseKeyword ? false : null;
  };
  const runParallel = bool("runParallel");
  const activated = bool("activated");
  const muted = bool("muted");
  const frequency = frequencyMinutes(objectProperty(options, "frequency"));
  if (name === null || rawLocations === null || runParallel === null || activated === null || muted === null || frequency === null) {
    errors.push("MultiStepCheck scheduling/identity settings do not resolve statically (UNCERTAIN)");
  }
  if (objectProperty(options, "tags") && !stringArrayLiteral(objectProperty(options, "tags"))) errors.push("MultiStepCheck tags do not resolve statically (UNCERTAIN)");
  const environmentKeys: string[] = [];
  const environmentDefinitions: MultiStepConstructModel["environmentDefinitions"] = [];
  const envExpr = objectProperty(options, "environmentVariables");
  if (envExpr && ts.isArrayLiteralExpression(envExpr)) {
    for (const element of envExpr.elements) {
      if (!ts.isObjectLiteralExpression(element)) {
        errors.push("MultiStepCheck environment key is not a static object (UNCERTAIN)");
        continue;
      }
      staticProperties(element, ["key", "value", "secret"], errors, "MultiStepCheck environment variable");
      const key = literalString(objectProperty(element, "key"));
      const value = objectProperty(element, "value");
      const secret = objectProperty(element, "secret");
      if (key && value) {
        environmentKeys.push(key);
        environmentDefinitions.push({ key, value: stripComments(value.getText(hit.sf)).trim(),
          secret: !secret ? null : secret.kind === ts.SyntaxKind.TrueKeyword ? true : secret.kind === ts.SyntaxKind.FalseKeyword ? false : null });
        if (secret && secret.kind !== ts.SyntaxKind.TrueKeyword && secret.kind !== ts.SyntaxKind.FalseKeyword) {
          errors.push("MultiStepCheck environment secret flag is not static — UNCERTAIN");
        }
      } else errors.push("MultiStepCheck environment variable key/value is not static (UNCERTAIN)");
    }
  } else if (envExpr) errors.push("MultiStepCheck environment variables are not a static array (UNCERTAIN)");
  // entrypoint: path.join(__dirname, "x.spec.ts") or a plain relative string
  let entrypoint: string | null = null;
  const code = objectProperty(options, "code");
  if (code && ts.isObjectLiteralExpression(code)) staticProperties(code, ["entrypoint"], errors, "MultiStepCheck code");
  const entryExpr = code && ts.isObjectLiteralExpression(code) ? objectProperty(code, "entrypoint") : null;
  if (entryExpr) {
    const direct = literalString(entryExpr);
    if (direct !== null) entrypoint = norm(path.posix.join(path.posix.dirname(hit.file), direct));
    else if (ts.isCallExpression(entryExpr) && ts.isPropertyAccessExpression(entryExpr.expression)
      && ts.isIdentifier(entryExpr.expression.expression) && entryExpr.expression.expression.text === "path"
      && entryExpr.expression.name.text === "join" && entryExpr.arguments.length === 2
      && ts.isIdentifier(entryExpr.arguments[0]) && entryExpr.arguments[0].text === "__dirname") {
      const file = literalString(entryExpr.arguments[1]);
      if (file !== null) entrypoint = norm(path.posix.join(path.posix.dirname(hit.file), file));
    }
    if (!entrypoint) errors.push(`MultiStepCheck code.entrypoint does not statically resolve in ${hit.file}`);
  } else {
    errors.push(`MultiStepCheck has no code.entrypoint in ${hit.file}`);
  }
  return {
    model: { logicalId, name, entrypoint, frequencyMinutes: frequency, locations, runParallel, activated, muted, tags, environmentKeys, environmentDefinitions, errors },
    constructFile: hit.file,
  };
}

interface StepSpan {
  step: MultiStepStepModel;
  callback: ts.ArrowFunction | ts.FunctionExpression;
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

const REQUEST_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

interface ConstInfo {
  init: ts.Expression | null;
  exported: boolean;
}

/** Imported modules resolve ONLY top-level const declarations. */
function constMapOf(sf: ts.SourceFile): Map<string, ConstInfo> {
  const map = new Map<string, ConstInfo>();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    const exported = (statement.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) map.set(decl.name.text, { init: decl.initializer ?? null, exported });
    }
  }
  return map;
}

interface ResolvedConst {
  value: string | number | boolean | null;
  provable: boolean;
  cycle?: boolean;
}

const UNRESOLVED: ResolvedConst = { value: null, provable: false };

function resolveConstExpr(expr: ts.Expression | null | undefined, consts: Map<string, ConstInfo>, depth: number, seen: Set<string>): ResolvedConst {
  if (!expr || depth > 8) return UNRESOLVED;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { value: expr.text, provable: true };
  if (ts.isNumericLiteral(expr)) return { value: Number(expr.text), provable: true };
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { value: true, provable: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { value: false, provable: true };
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { value: null, provable: true };
  if (ts.isIdentifier(expr)) {
    if (seen.has(expr.text)) return { ...UNRESOLVED, cycle: true };
    const info = consts.get(expr.text);
    if (!info) return UNRESOLVED;
    return resolveConstExpr(info.init, consts, depth + 1, new Set([...seen, expr.text]));
  }
  return UNRESOLVED;
}

interface ImportedBinding {
  /** Local imports can only carry inert, exported static consts. */
  kind: "const" | "other";
  resolved: ResolvedConst;
  derived: boolean;
}

function bindingContainsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some((element) => ts.isBindingElement(element) && bindingContainsName(element.name, name));
}

/** Find the NEAREST lexical binding, including shadowing by destructuring,
 * mutable vars and callback parameters. A token spelling is not a provenance
 * proof for the request fixture or Playwright's test/expect imports. */
function lexicalDeclaration(name: string, at: ts.Node): { decl: ts.VariableDeclaration; constant: boolean } | "import" | "shadowed" | null {
  let node: ts.Node | undefined = at;
  while (node) {
    if (ts.isFunctionLike(node)) {
      for (const param of node.parameters) if (bindingContainsName(param.name, name)) return "shadowed";
    }
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      for (const statement of node.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const decl of statement.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === name) {
              return { decl, constant: Boolean(statement.declarationList.flags & ts.NodeFlags.Const) };
            }
            if (!ts.isIdentifier(decl.name) && bindingContainsName(decl.name, name)) return "shadowed";
          }
        }
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return "shadowed";
        if (ts.isImportDeclaration(statement) && statement.importClause) {
          const clause = statement.importClause;
          if (clause.name?.text === name) return "import";
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some((e) => e.name.text === name)) return "import";
        }
      }
    }
    node = node.parent;
  }
  return null;
}

function isPlaywrightBinding(name: "test" | "expect", at: ts.Node): boolean {
  if (lexicalDeclaration(name, at) !== "import") return false;
  return at.getSourceFile().statements.some((s) =>
    ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "@playwright/test"
      && !s.importClause?.isTypeOnly && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
      && s.importClause.namedBindings.elements.some((e) => !e.propertyName && e.name.text === name));
}

function unwrap(expr: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) return unwrap(expr.expression);
  return expr;
}

/** A locally shadowed helper must not inherit the top-level wrapper's proof. */
function unshadowedTopLevelFunction(name: string, at: ts.Node): boolean {
  const sf = at.getSourceFile();
  let scope: ts.Node | undefined = at;
  while (scope && scope !== sf) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((p) => bindingContainsName(p.name, name))) return false;
    if (ts.isBlock(scope) && scope.statements.some((statement) =>
      (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => bindingContainsName(d.name, name)))
        || ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name))) return false;
    scope = scope.parent;
  }
  if (!sf.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === name)) return false;
  return !sf.statements.some((s) =>
    (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => bindingContainsName(d.name, name)))
    || (ts.isImportDeclaration(s) && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings)
      && s.importClause.namedBindings.elements.some((e) => e.name.text === name)));
}

/** Only pure identity/URL-origin validators may propagate a trusted URL. */
function verifiedWrapper(name: string, at: ts.Node): boolean {
  if (!unshadowedTopLevelFunction(name, at)) return false;
  const sf = at.getSourceFile();
  const decl = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!decl?.body || !decl.parameters.length || !ts.isIdentifier(decl.parameters[0]!.name)) return false;
  const param = decl.parameters[0]!.name.text;
  const statements = decl.body.statements;
  const ret = statements.at(-1);
  if (!ret || !ts.isReturnStatement(ret) || !ret.expression) return false;
  let urlVar: string | null = null;
  for (const statement of statements.slice(0, -1)) {
    if (ts.isIfStatement(statement) && !statement.elseStatement) {
      const guard = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
      if (guard.length !== 1 || !ts.isThrowStatement(guard[0])) return false;
    } else if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) && statement.declarationList.declarations.length === 1) {
      const v = statement.declarationList.declarations[0]!;
      if (!ts.isIdentifier(v.name) || !v.initializer || !ts.isNewExpression(v.initializer)
        || !ts.isIdentifier(v.initializer.expression) || v.initializer.expression.text !== "URL"
        || lexicalDeclaration("URL", v.initializer) !== null
        || v.initializer.arguments?.length !== 1 || !ts.isIdentifier(v.initializer.arguments[0])
        || v.initializer.arguments[0].text !== param || urlVar !== null) return false;
      urlVar = v.name.text;
    } else return false;
    // Guards must not assign to the verified input or output binding.
    let mutated = false;
    const check = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        if (n.left.getText(sf).startsWith(param) || (urlVar && n.left.getText(sf).startsWith(urlVar))) mutated = true;
      }
      ts.forEachChild(n, check);
    };
    check(statement);
    if (mutated) return false;
  }
  const value = unwrap(ret.expression);
  return ts.isIdentifier(value) && value.text === param
    || Boolean(urlVar && ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === urlVar && value.name.text === "origin");
}

/** Resolve literals from their actual lexical scope, never a global name map. */
function lexicalLiteral(expr: ts.Expression, imports: Map<string, ImportedBinding>, errors: string[], depth = 0, seen = new Set<ts.VariableDeclaration>()): ResolvedConst {
  const node = unwrap(expr);
  if (depth > 8) return UNRESOLVED;
  if (ts.isIdentifier(node)) {
    const binding = lexicalDeclaration(node.text, node);
    if (binding === "import") {
      const imported = imports.get(node.text);
      return imported?.kind === "const" ? imported.resolved : UNRESOLVED;
    }
    if (!binding || typeof binding !== "object" || !binding.constant || !binding.decl.initializer || binding.decl.getStart() > node.getStart()) return UNRESOLVED;
    if (seen.has(binding.decl)) {
      errors.push("constant cycle in Multistep source — UNCERTAIN before execution");
      return UNRESOLVED;
    }
    return lexicalLiteral(binding.decl.initializer, imports, errors, depth + 1, new Set([...seen, binding.decl]));
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { value: node.text, provable: true };
  if (ts.isNumericLiteral(node)) return { value: Number(node.text), provable: true };
  return UNRESOLVED;
}

/** URL data flow: direct env read → const-only lexical chain → verified wrapper. */
function exprDerivesEnv(expr: ts.Expression | null | undefined, imports: Map<string, ImportedBinding>, errors: string[], depth = 0, seen = new Set<ts.VariableDeclaration>()): boolean {
  if (!expr || depth > 8) return false;
  const node = unwrap(expr);
  if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const envAccess = node.expression;
    return ts.isIdentifier(envAccess.expression) && envAccess.expression.text === "process"
      && lexicalDeclaration("process", node) === null && envAccess.name.text === "env" && node.name.text === "ENVIRONMENT_URL";
  }
  if (ts.isIdentifier(node)) {
    const binding = lexicalDeclaration(node.text, node);
    if (binding === "import") return imports.get(node.text)?.derived === true;
    if (!binding || typeof binding !== "object" || !binding.constant || !binding.decl.initializer || binding.decl.getStart() > node.getStart()) return false;
    if (seen.has(binding.decl)) {
      errors.push("constant cycle in Multistep URL provenance — UNCERTAIN before execution");
      return false;
    }
    return exprDerivesEnv(binding.decl.initializer, imports, errors, depth + 1, new Set([...seen, binding.decl]));
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && verifiedWrapper(node.expression.text, node)) {
    // No arbitrary call becomes trusted merely because an argument references
    // ENVIRONMENT_URL. Only the exact value-propagating argument is accepted.
    return node.arguments.length > 0 && exprDerivesEnv(node.arguments[0], imports, errors, depth + 1, seen)
      && node.arguments.slice(1).every((arg) => ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg));
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
    if (base === ".." || base.startsWith("../")) return null;
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, `${base}/index.ts`];
    for (const candidate of candidates) {
      const key = fileByNorm.get(candidate);
      if (key !== undefined && /\.[cm]?[jt]sx?$/.test(candidate)) return key;
    }
    return null;
  };

  const active = new Set<string>();
  const walk = (file: string, source: string, depth: number): void => {
    const fileKey = norm(file);
    if (active.has(fileKey)) {
      errors.push("local import cycle is unsupported — UNCERTAIN before execution");
      return;
    }
    if (seenFiles.has(fileKey)) return;
    if (depth > 8 || fileCount >= 32) {
      errors.push("local import graph exceeds its depth/file bound — UNCERTAIN before execution");
      return;
    }
    active.add(fileKey);
    seenFiles.add(fileKey);
    fileCount += 1;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const consts = constMapOf(sf);
    parsedConsts.set(fileKey, consts);
    // Every transitively imported file is EXECUTED by Node, not just the
    // imported binding. Only inert const-only modules are admissible. A
    // function, class, initializer call, side-effect import, node: import or
    // re-export is unsupported even when the imported constant is a literal.
    if (depth > 0) {
      for (const statement of sf.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause?.isTypeOnly) {
          continue; // erased at runtime
        }
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
          const spec = statement.moduleSpecifier.text;
          if (!spec.startsWith("./") && !spec.startsWith("../")) {
            errors.push("executable or external import in local module — UNCERTAIN before execution");
          }
        } else if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer
              || (!resolveConstExpr(declaration.initializer, consts, 0, new Set()).provable
                && !exprDerivesEnv(declaration.initializer, new Map(), errors))) {
              errors.push("non-static initializer in local import — UNCERTAIN before execution");
            }
          }
        } else if (!ts.isEmptyStatement(statement)) {
          errors.push("executable statement in local import — UNCERTAIN before execution");
        }
      }
    }
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
      const spec = statement.moduleSpecifier.text;
      const isRelative = spec.startsWith("./") || spec.startsWith("../");
      if (!isRelative) continue; // bare imports in modules were rejected above
      const target = resolveModule(file, spec);
      if (target === null) {
        errors.push("unresolved local import in Multistep source — UNCERTAIN before execution");
        continue;
      }
      const clause = statement.importClause;
      if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.name || clause.namedBindings.elements.length === 0) {
        errors.push("unsupported local import form — only named static consts are supported (UNCERTAIN)");
        continue;
      }
      const targetKey = norm(target);
      if (active.has(targetKey)) errors.push("local import cycle is unsupported — UNCERTAIN before execution");
      if (!seenFiles.has(targetKey)) {
        const targetSource = projectFiles.get(target);
        if (targetSource === undefined) {
          errors.push("unresolved local import in Multistep source — UNCERTAIN before execution");
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
          if (resolved.cycle) errors.push("constant cycle in local import — UNCERTAIN before execution");
          const derived = info.init ? exprDerivesEnv(info.init, new Map(), errors) : false;
          bindings.set(localName, { kind: "const", resolved, derived });
          if (!resolved.provable && !derived) errors.push("imported constant cannot be resolved statically — UNCERTAIN before execution");
        } else {
          bindings.set(localName, { kind: "other", resolved: UNRESOLVED, derived: false });
        }
      }
    }
    active.delete(fileKey);
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

function headerAndBodyKeys(call: ts.CallExpression, sf: ts.SourceFile, errors: string[]): { headerKeys: string[]; bodyKeys: string[]; usesBearer: boolean; optionsShape: string } {
  const headerKeys: string[] = [];
  const bodyKeys: string[] = [];
  let usesBearer = false;
  const options = call.arguments[1];
  if (call.arguments.length > 2 || (options && !ts.isObjectLiteralExpression(options))) {
    errors.push("request options are not a static object — UNCERTAIN before execution");
  }
  if (options && ts.isObjectLiteralExpression(options)) {
    staticProperties(options, ["headers", "data"], errors, "request options");
    const headers = objectProperty(options, "headers");
    if (headers) {
      if (!ts.isObjectLiteralExpression(headers)) errors.push("request headers are not a static object — UNCERTAIN before execution");
      else {
        const names = new Set<string>();
        for (const property of headers.properties) {
          const name = ts.isPropertyAssignment(property) ? propName(property.name) : null;
          if (!name || names.has(name)) { errors.push("request headers contain a duplicate or computed property — UNCERTAIN before execution"); continue; }
          names.add(name);
          headerKeys.push(name);
          if (ts.isPropertyAssignment(property) && /Bearer\s/.test(property.initializer.getText(sf))) usesBearer = true;
        }
      }
    }
    const data = objectProperty(options, "data");
    if (data) {
      if (!ts.isObjectLiteralExpression(data)) errors.push("request data is not a static object — UNCERTAIN before execution");
      else {
        const names = new Set<string>();
        for (const property of data.properties) {
          const name = ts.isShorthandPropertyAssignment(property) ? property.name.text : ts.isPropertyAssignment(property) ? propName(property.name) : null;
          if (!name || names.has(name)) { errors.push("request data contain a duplicate, spread or computed property — UNCERTAIN before execution"); continue; }
          names.add(name);
          bodyKeys.push(name);
        }
      }
    }
  }
  return { headerKeys, bodyKeys, usesBearer, optionsShape: options ? stripComments(options.getText(sf)).trim() : "" };
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
  const clean = stripComments(source);

  // ---- imports: node:/@playwright/test resolve bare; relative imports resolve
  // through the project files with bounded static const resolution ----
  const localBindings: Map<string, ImportedBinding> = projectFiles ? scanLocalImports(file, source, projectFiles, errors) : new Map();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const spec = statement.moduleSpecifier.text;
    if (statement.importClause?.isTypeOnly) continue; // erased by TypeScript
    if (spec.startsWith("./") || spec.startsWith("../")) {
      if (!projectFiles) errors.push("unresolved local import in Multistep source — UNCERTAIN before execution");
      continue;
    }
    if (spec !== "@playwright/test") {
      errors.push(`unsupported executable import in ${file} — only @playwright/test and inert local consts are supported (UNCERTAIN)`);
    } else {
      const named = statement.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named) || statement.importClause?.name
        || named.elements.some((element) => element.propertyName || !["test", "expect"].includes(element.name.text))) {
        errors.push("unsupported Playwright import form — only test and expect are modeled (UNCERTAIN)");
      }
    }
  }

  // ---- request-fixture aliases are deliberately unmodeled ----
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
        requestAliases.add(node.name.text);
      }
      ts.forEachChild(node, aliasVisit);
    };
    aliasVisit(sf);
  }
  const resolveTitleExpr = (expr: ts.Expression | null | undefined): string | null => {
    if (!expr) return null;
    const result = lexicalLiteral(expr, localBindings, errors);
    return result.provable && typeof result.value === "string" ? result.value : null;
  };

  // Bind each modeled step to the one top-level Playwright test callback that
  // will actually run. Steps in dead helpers, other tests, nested functions or
  // detached callbacks are not evidence of an executed transaction.
  const testCalls: ts.CallExpression[] = [];
  const collectTests = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test"
      && ts.isExpressionStatement(node.parent) && ts.isSourceFile(node.parent.parent)) testCalls.push(node);
    ts.forEachChild(node, collectTests);
  };
  collectTests(sf);
  const testCallback = testCalls.length === 1 ? testCalls[0]!.arguments[1] : null;
  const testBody = testCallback && (ts.isArrowFunction(testCallback) || ts.isFunctionExpression(testCallback)) && ts.isBlock(testCallback.body)
    ? testCallback.body : null;
  if (testCalls.length !== 1 || !testBody || !testCallback || !(ts.isArrowFunction(testCallback) || ts.isFunctionExpression(testCallback))
    || !testCallback.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    || (testCalls.length === 1 && !isPlaywrightBinding("test", testCalls[0]!))) {
    errors.push("Multistep source must execute exactly one async top-level Playwright test callback — UNCERTAIN before execution");
  }
  const requestFixtureAt = (node: ts.Node): boolean => {
    if (!testBody || !testCallback || !(ts.isArrowFunction(testCallback) || ts.isFunctionExpression(testCallback))) return false;
    // The only modeled request object is Playwright's unaliased fixture in
    // the actual test callback. A same-named local const or nested callback
    // parameter is not that fixture, even when its method spelling matches.
    const binding = testCallback.parameters[0]?.name;
    if (!binding || !ts.isObjectBindingPattern(binding) || !binding.elements.some((element) =>
      ts.isIdentifier(element.name) && element.name.text === "request"
        && (!element.propertyName || (ts.isIdentifier(element.propertyName) && element.propertyName.text === "request")))) return false;
    let scope: ts.Node | undefined = node;
    while (scope && scope !== testCallback) {
      if (ts.isFunctionLike(scope) && scope.parameters.some((p) => bindingContainsName(p.name, "request"))) return false;
      if (ts.isBlock(scope) && scope.statements.some((statement) =>
        (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => bindingContainsName(d.name, "request")))
          || ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === "request"))) return false;
      scope = scope.parent;
    }
    return scope === testCallback;
  };
  const responseFromRequestAt = (node: ts.Node): boolean => {
    const binding = lexicalDeclaration("response", node);
    if (!binding || typeof binding !== "object" || !binding.constant || !binding.decl.initializer
      || binding.decl.getStart() > node.getStart()) return false;
    const value = unwrap(binding.decl.initializer);
    if (!ts.isAwaitExpression(value)) return false;
    const call = unwrap(value.expression);
    return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
      && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === "request"
      && REQUEST_METHODS.has(call.expression.name.text) && requestFixtureAt(call);
  };
  const bodyFromResponseAt = (node: ts.Node): boolean => {
    const binding = lexicalDeclaration("body", node);
    if (!binding || typeof binding !== "object" || !binding.constant || !binding.decl.initializer
      || binding.decl.getStart() > node.getStart()) return false;
    const value = unwrap(binding.decl.initializer);
    if (!ts.isAwaitExpression(value)) return false;
    const call = unwrap(value.expression);
    return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
      && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === "response"
      && call.expression.name.text === "json" && responseFromRequestAt(call);
  };
  const steps: MultiStepStepModel[] = [];
  const spans: StepSpan[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "step"
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "test") {
      if (!isPlaywrightBinding("test", node)) errors.push("shadowed test.step is not the Playwright step primitive — UNCERTAIN before execution");
      const title = resolveTitleExpr(node.arguments[0] as ts.Expression);
      if (title === null) {
        errors.push(`test.step title in ${file} is not a static string — unsupported syntax is UNCERTAIN`);
      } else {
        const awaited = ts.isAwaitExpression(node.parent);
        const direct = awaited && ts.isExpressionStatement(node.parent.parent) && node.parent.parent.parent === testBody;
        const callback = node.arguments[1];
        if (!direct || !callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body)) {
          errors.push("test.step is not directly awaited inside the executed test callback — UNCERTAIN before execution");
        }
        const conditional = Boolean(testBody && isConditionalContext(node, testBody));
        const step: MultiStepStepModel = { title, index: steps.length, line: sourceLine(sf, node), awaited, conditional };
        steps.push(step);
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) spans.push({ step, callback });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const enclosingStep = (node: ts.Node): MultiStepStepModel | null => {
    let current: ts.Node | undefined = node;
    while (current && current !== sf) {
      const found = spans.find((span) => current === span.callback);
      if (found) return found.step;
      if (ts.isFunctionLike(current)) return null; // nested helper, not a modeled step callback
      current = current.parent;
    }
    return null;
  };

  // ---- requests: the real request methods of the canonical transaction,
  // ENVIRONMENT_URL derivation proof, and unknown-helper detection ----
  const requests: MultiStepRequestModel[] = [];
  const isExpectMatcher = (callee: ts.Expression): boolean => {
    let base: ts.Expression = callee;
    while (ts.isPropertyAccessExpression(base)) base = base.expression;
    return ts.isCallExpression(base) && ts.isIdentifier(base.expression) && base.expression.text === "expect";
  };
  const visitRequests = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && !ts.isIdentifier(node.expression)) {
      errors.push("dynamic constructor in Multistep source — UNCERTAIN before execution");
    } else if (ts.isNewExpression(node) && !["URL", "Error"].includes(node.expression.getText(sf))) {
      errors.push("unknown constructor in Multistep source — UNCERTAIN before execution");
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
      && (node.expression.text === "URL" || node.expression.text === "Error")
      && lexicalDeclaration(node.expression.text, node) !== null) {
      errors.push("shadowed URL/Error constructor is not a verified global — UNCERTAIN before execution");
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text === "fetch") {
          errors.push(`fetch() in ${file} is an unsupported request helper — helpers outside request.<method> are UNCERTAIN`);
        } else if (localBindings.has(callee.text)) {
          errors.push(`imported helper "${callee.text}" in ${file} is unsupported — imported wrappers/helpers must be UNCERTAIN`);
        } else if (callee.text === "test" || callee.text === "expect") {
          if (!isPlaywrightBinding(callee.text, node)) errors.push("shadowed Playwright test/expect primitive — UNCERTAIN before execution");
        } else if (!verifiedWrapper(callee.text, node)) {
          errors.push("unknown helper call in Multistep source — UNCERTAIN before execution");
        }
      } else if (ts.isElementAccessExpression(callee)) {
        const recv = callee.expression;
        if (ts.isIdentifier(recv) && (recv.text === "request" || requestAliases.has(recv.text))) {
          errors.push(`computed request access in ${file} is unsupported — requests must call request.<method> directly (UNCERTAIN)`);
        } else {
          errors.push("computed helper call in Multistep source — UNCERTAIN before execution");
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const receiver = callee.expression;
        const recv = ts.isIdentifier(receiver) ? receiver.text : null;
        const name = callee.name.text;
        const controlBinding = recv === "CONTROL_CHARACTERS" ? lexicalDeclaration(recv, node) : null;
        const safeBuiltin = (((recv === "Array" && name === "isArray") || (recv === "Number" && name === "isInteger")
          || (recv === "URL" && name === "canParse")) && lexicalDeclaration(recv!, node) === null)
          || (recv === "CONTROL_CHARACTERS" && name === "test" && controlBinding && typeof controlBinding === "object"
            && controlBinding.constant && controlBinding.decl.initializer && ts.isRegularExpressionLiteral(controlBinding.decl.initializer))
          || (recv === "response" && (name === "json" || name === "status") && responseFromRequestAt(node));
        if (REQUEST_METHODS.has(name)) {
          if (recv === "request") {
            if (!requestFixtureAt(node)) errors.push("request method does not use the executed Playwright request fixture — UNCERTAIN before execution");
            const urlExpr = node.arguments[0];
            const url = urlExpr ? literalString(urlExpr) ?? (ts.isTemplateExpression(urlExpr) ? urlExpr.getText(sf) : null) : null;
            if (url === null) {
              errors.push(`request.${name} URL in ${file} does not resolve statically — unsupported syntax is UNCERTAIN`);
            }
            const line = sourceLine(sf, node);
            let derived = Boolean(urlExpr && exprDerivesEnv(urlExpr, localBindings, errors));
            if (urlExpr && ts.isTemplateExpression(urlExpr) && urlExpr.head.text === "" && urlExpr.templateSpans.length === 1) {
              derived = exprDerivesEnv(urlExpr.templateSpans[0]!.expression, localBindings, errors);
            }
            if (!derived) errors.push(`request URL at ${file}:${line} does not statically derive from process.env.ENVIRONMENT_URL — origin provenance without a fallback is UNCERTAIN`);
            const step = enclosingStep(node);
            if (!step) errors.push("request occurs outside an executed test.step callback — UNCERTAIN before execution");
            const { headerKeys, bodyKeys, usesBearer, optionsShape } = headerAndBodyKeys(node, sf, errors);
            requests.push({ stepTitle: step?.title ?? null, method: name.toUpperCase(), urlTemplate: url ?? "<unresolved>", headerKeys, bodyKeys, usesBearer, optionsShape, line });
          } else if (recv && requestAliases.has(recv)) {
            errors.push(`request alias "${recv}" in ${file} is unsupported — requests must call request.<method> directly (UNCERTAIN)`);
          } else {
            errors.push("request-capable receiver is unsupported — only the request fixture is modeled (UNCERTAIN)");
          }
        } else if (!safeBuiltin && !(recv === "test" && name === "step") && !isExpectMatcher(callee)) {
          errors.push("unknown helper call in Multistep source — UNCERTAIN before execution");
        }
      } else {
        errors.push("dynamic helper call in Multistep source — UNCERTAIN before execution");
      }
    }
    ts.forEachChild(node, visitRequests);
  };
  visitRequests(sf);

  // ---- assertions: exact AST calls, with the SAME normalizeSubject +
  // assertionId identity as the inventory. The enclosing callback, rather
  // than overlapping line ranges, binds every tuple to an executed step.
  const assertions: MultiStepAssertionModel[] = [];
  const referencesBinding = (node: ts.Node | undefined, name: string): boolean => {
    if (!node) return false;
    if (ts.isIdentifier(node) && node.text === name
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) return true;
    return ts.forEachChild(node, (child) => referencesBinding(child, name) ? true : undefined) ?? false;
  };
  const visitAsserts = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      let chain: ts.Expression = node.expression.expression;
      if (ts.isPropertyAccessExpression(chain) && chain.name.text === "not") chain = chain.expression;
      if (ts.isCallExpression(chain) && ts.isIdentifier(chain.expression) && chain.expression.text === "expect") {
        if (!isPlaywrightBinding("expect", chain)) errors.push("assertion uses a shadowed expect, not Playwright's hard assertion primitive — UNCERTAIN before execution");
        const matcher = node.expression.name.text;
        const subjectExpr = chain.arguments[0];
        const targetExpr = node.arguments[0];
        if ((referencesBinding(subjectExpr, "response") || referencesBinding(targetExpr, "response")) && !responseFromRequestAt(node)) {
          errors.push("assertion response is not bound to the executed Playwright request — UNCERTAIN before execution");
        }
        if ((referencesBinding(subjectExpr, "body") || referencesBinding(targetExpr, "body")) && !bodyFromResponseAt(node)) {
          errors.push("assertion payload is not bound to the executed Playwright response — UNCERTAIN before execution");
        }
        const subject = normalizeSubject(subjectExpr ? stripComments(subjectExpr.getText(sf)) : "");
        const target = normalizeSubject(targetExpr ? stripComments(targetExpr.getText(sf)) : "");
        const lineNumber = sourceLine(sf, node);
        if (!isKnownMatcher(matcher)) errors.push(`unsupported matcher "${matcher}" at ${file}:${lineNumber} — unsupported matchers are UNCERTAIN`);
        const step = enclosingStep(node);
        if (!step) errors.push("assertion occurs outside an executed test.step callback — UNCERTAIN before execution");
        // Do not treat a name declared in an unrelated function or step as a
        // binding for THIS assertion. Visit every referenced identifier,
        // including non-leading ones hidden inside a larger expression.
        const checkReferences = (expression: ts.Node): void => {
          if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
            checkReferences(expression.expression); // types are erased, not runtime bindings
            return;
          }
          if (ts.isIdentifier(expression)) {
            const parent = expression.parent;
            const propertyName = (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === expression;
            if (!propertyName && !KEYWORD_OR_GLOBAL_ROOTS.has(expression.text)
              && lexicalDeclaration(expression.text, expression) === null) {
              errors.push(`unresolved expression "${expression.text}" at ${file}:${lineNumber} — unresolved expressions are UNCERTAIN`);
            }
            return;
          }
          ts.forEachChild(expression, checkReferences);
        };
        if (subjectExpr) checkReferences(subjectExpr);
        if (targetExpr) checkReferences(targetExpr);
        if (/\?\?|\|\|/.test(target) || /\?\?|\|\|/.test(subject)) banned.push(`compatibility repair in assertion target at ${file}:${lineNumber}`);
        assertions.push({ stepTitle: step?.title ?? null, id: assertionId(subject, matcher, target), subject, matcher, target, sourceLine: lineNumber });
      }
    }
    ts.forEachChild(node, visitAsserts);
  };
  visitAsserts(sf);

  // Bind the transaction's environment/account/slot/token setup as source
  // data flow, not merely as unchanged identifier spellings in request calls.
  // In particular, `const region = 'us-east-1'` must not silently make both
  // configured locations share one account; changing SELECTED_SLOT must not
  // launder the same assertion ID into a different booking request.
  const guarded = new Set([
    "CONTROL_CHARACTERS", "MONITORING_ACCOUNTS_BY_REGION", "region", "account", "SELECTED_SLOT", "rawEnvironmentUrl", "origin", "bearerToken",
    // Runtime data that carries the login/session/booking relationship across
    // steps. Preserving just the final expect() text is not enough if these
    // assignments can be replaced by constants or unrelated local values.
    "loginAccount", "loginVersion", "sessionAccount", "sessionTokenVersion", "sessionCurrentVersion",
    "slots", "bookingAccount", "bookingSlot", "bookingVersion", "bookingConfirmed", "bookingResult",
  ]);
  const evidenceAlias = (name: string, at: ts.Node, seen = new Set<string>()): boolean => {
    if (["response", "body", "request", "test", "expect", "Array", "Number", "URL", "Error", "globalThis"].includes(name)) return true;
    if (seen.has(name)) return false;
    const binding = lexicalDeclaration(name, at);
    if (!binding || typeof binding !== "object" || !binding.decl.initializer) return false;
    const initializer = unwrap(binding.decl.initializer);
    return ts.isIdentifier(initializer) && evidenceAlias(initializer.text, initializer, new Set([...seen, name]));
  };
  const propertyRoot = (value: ts.Expression): string | null => {
    let node = unwrap(value);
    while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) node = unwrap(node.expression);
    return ts.isIdentifier(node) ? node.text : null;
  };
  const securityBindings: string[] = [];
  const securityVisit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && guarded.has(node.name.text)) {
      const list = node.parent;
      const declarationKind = ts.isVariableDeclarationList(list)
        ? (list.flags & ts.NodeFlags.Const ? "const" : list.flags & ts.NodeFlags.Let ? "let" : "var") : "unknown";
      securityBindings.push(`declare:${node.name.text}:${declarationKind}:${node.initializer ? stripComments(node.initializer.getText(sf)).trim() : "<uninitialized>"}`);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = node.left.getText(sf);
      const root = propertyRoot(node.left);
      if (root && (evidenceAlias(root, node.left) || (root === "process" && left.startsWith("process.env")))) {
        errors.push("Playwright assertion, request, response, payload or runtime environment is mutated — UNCERTAIN before execution");
      }
      if (root && guarded.has(root) || left.startsWith("process.env.")) {
        securityBindings.push(`write:${left}:${node.operatorToken.getText(sf)}:${stripComments(node.right.getText(sf)).trim()}`);
        if (left.includes("[") || left.includes(".") || left.startsWith("process.env.")) errors.push("security-critical Multistep environment or account binding is mutated — UNCERTAIN before execution");
      }
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      const root = propertyRoot(node.operand);
      if (root && (evidenceAlias(root, node.operand) || (root === "process" && node.operand.getText(sf).startsWith("process.env")))) {
        errors.push("Playwright response, payload or runtime environment is mutated — UNCERTAIN before execution");
      }
    }
    ts.forEachChild(node, securityVisit);
  };
  securityVisit(sf);

  // ---- ENVIRONMENT_URL origin usage ----
  const readsEnvironmentUrl = /process\.env\.ENVIRONMENT_URL\b/.test(clean);
  const environmentUrlFallback = /ENVIRONMENT_URL\s*(?:\?\?|\|\|)/.test(clean);
  if (environmentUrlFallback) banned.push("ENVIRONMENT_URL has a fallback (hardcoded-host dodge)");

  const hardcodedHosts = [...clean.matchAll(HOST_LITERAL)].map((m) => m[0].slice(1, -1));
  if (hardcodedHosts.length) banned.push("hardcoded host in source");

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
    securityBindings,
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

  // Locate the executed script from the construct entrypoint, or from the
  // explicit preferred file ONLY when no construct entrypoint is available.
  // A basename match is never sufficient evidence of source identity.
  let scriptFile: string | null = construct?.model.entrypoint ?? null;
  // No basename fallback: the deployed construct's path must be exactly the
  // script that will be executed, not a same-named file in another directory.
  if (!scriptFile && preferredFile) scriptFile = norm(preferredFile);
  if (preferredFile && scriptFile && norm(preferredFile) !== scriptFile) {
    errors.push("constructed Multistep entrypoint differs from the executed check file — UNCERTAIN before execution");
  }
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
