// Effective Playwright Check model, resolved from the BUNDLE'S OWN captured
// files — checkly.config.ts (playwrightConfigPath, pwProjects, retries) plus
// playwright.config.ts (projects, tags, testDir, retries, baseURL).
//
// Phase 9 tasks 9.1 and 9.4 require resolving the final EFFECTIVE
// configuration from project defaults, groups, check-specific settings,
// imported configuration and check-type settings — never assuming a default.
// Nothing here invents a Checkly default: a value that cannot be read from the
// captured files is simply absent, and the caller records it as UNKNOWN.

import ts from "typescript";

export interface EffectivePlaywrightModel {
  configPath: string | null;
  projects: string[] | null;
  tags: string[] | null;
  testSelection: string[] | null;
  retries: number | null;
  /** The environment variable the config derives its base URL from, or null. */
  targetVariable: string | null;
  /** The static fallback URL, only when the config hardcodes one. */
  targetFallback: string | null;
}

const UNRESOLVED: EffectivePlaywrightModel = {
  configPath: null, projects: null, tags: null, testSelection: null,
  retries: null, targetVariable: null, targetFallback: null,
};

function parse(source: string): ts.SourceFile | null {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const file = ts.createSourceFile("playwright-model.ts", text, ts.ScriptTarget.Latest, true,
    /\.tsx?$/.test("x.tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if ((file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return null;
  return file;
}

function objectProperty(node: ts.ObjectLiteralExpression | undefined, name: string): ts.Expression | undefined {
  for (const property of node?.properties ?? []) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = property.name;
    if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === name) return property.initializer;
  }
  return undefined;
}

function firstObjectArgument(source: string, callee: string): ts.ObjectLiteralExpression | null {
  const file = parse(source);
  if (!file) return null;
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      for (const argument of node.arguments) {
        if (ts.isObjectLiteralExpression(argument)) { found = argument; return; }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

function stringArray(expression: ts.Expression | undefined): string[] | null {
  if (!expression) return null;
  const file = parse("null")!;
  const evaluated = tryEvaluate(expression, file);
  return Array.isArray(evaluated) && evaluated.every((item) => typeof item === "string") ? evaluated as string[] : null;
}

/** Resolve a literal, array literal, `??` chain or `process.env.X` reference. */
function tryEvaluate(node: ts.Expression, file: ts.SourceFile): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) { const n = Number(node.text); return Number.isFinite(n) ? n : undefined; }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => tryEvaluate(element, file));
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const left = tryEvaluate(node.left, file);
    return left === null || left === undefined ? tryEvaluate(node.right, file) : left;
  }
  if (ts.isBinaryExpression(node)) {
    const left = tryEvaluate(node.left, file);
    const right = tryEvaluate(node.right, file);
    if (typeof left === "number" && typeof right === "number") {
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: return left + right;
        default: return undefined;
      }
    }
    return undefined;
  }
  if (ts.isPropertyAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process"
    && node.expression.name.text === "env") {
    return undefined; // an unresolved env read is never treated as a literal
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === "undefined" && node.name.text === "length") return 0;
  return undefined;
}

/** Resolve a top-level `const NAME = <literal>` in the same file. */
function constLiteral(source: string, name: string): unknown {
  const file = parse(source);
  if (!file) return undefined;
  let result: unknown;
  const visit = (node: ts.Node): void => {
    if (result !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      result = tryEvaluate(node.initializer, file);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return result;
}

/** The `defineConfig({...})` object from a playwright.config.ts. */
function configObject(source: string): ts.ObjectLiteralExpression | null {
  for (const callee of ["defineConfig", "definePlaywrightConfig"]) {
    const found = firstObjectArgument(source, callee);
    if (found) return found;
  }
  const file = parse(source);
  if (!file) return null;
  let fallback: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (fallback) return;
    if (ts.isExportAssignment(node) && ts.isObjectLiteralExpression(node.expression)) fallback = node.expression;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return fallback;
}

/**
 * Resolve the effective Playwright model from the captured config sources.
 *
 * `checklyConfigSource` is optional: when the Checkly project declares
 * `playwrightConfigPath` and `pwProjects`, those are the check-scoped overrides
 * and win over the Playwright file's own defaults.
 */
export function resolveEffectivePlaywrightModel(
  playwrightConfigSource: string,
  checklyConfigSource?: string | null,
  knownConfigPath?: string | null,
): EffectivePlaywrightModel {
  if (!playwrightConfigSource) return UNRESOLVED;
  const pw = configObject(playwrightConfigSource);
  // An unreadable config resolves NOTHING — including the caller-supplied path.
  // Returning a partially-known model here would let a bundle look protected.
  if (!pw) return UNRESOLVED;

  const projectsExpression = objectProperty(pw, "projects");
  const projectNames: string[] = [];
  if (projectsExpression && ts.isArrayLiteralExpression(projectsExpression)) {
    for (const entry of projectsExpression.elements) {
      if (!ts.isObjectLiteralExpression(entry)) continue;
      const name = objectProperty(entry, "name");
      if (name) {
        const value = tryEvaluate(name, parse("null")!);
        if (typeof value === "string") projectNames.push(value);
      }
    }
  }
  const retriesExpression = objectProperty(pw, "retries");
  const retries = retriesExpression ? tryEvaluate(retriesExpression, parse("null")!) : undefined;
  const useBlock = objectProperty(pw, "use");
  const useObject = useBlock && ts.isObjectLiteralExpression(useBlock) ? useBlock : undefined;
  const baseUrlExpression = objectProperty(useObject, "baseURL");

  let targetVariable: string | null = null;
  let targetFallback: string | null = null;
  const recordFallback = (expression: ts.Expression): void => {
    // A fallback may be a literal or a top-level const, which must be resolved
    // by name rather than assumed.
    let fallback = tryEvaluate(expression, parse("null")!);
    if (fallback === undefined && ts.isIdentifier(expression)) {
      fallback = constLiteral(playwrightConfigSource, expression.text);
    }
    if (typeof fallback === "string") targetFallback = fallback;
  };
  const isEnvRead = (node: ts.Expression | undefined): boolean => !!node && ts.isPropertyAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process"
    && node.expression.name.text === "env";
  if (!baseUrlExpression) {
    // no baseURL at all — nothing is recorded about the target
  } else if (ts.isBinaryExpression(baseUrlExpression)
    && baseUrlExpression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    if (ts.isElementAccessExpression(baseUrlExpression.left)) {
      const argument = baseUrlExpression.left.argumentExpression;
      if (argument && ts.isStringLiteral(argument)) targetVariable = argument.text;
    } else if (isEnvRead(baseUrlExpression.left)) targetVariable = (baseUrlExpression.left as ts.PropertyAccessExpression).name.text;
    recordFallback(baseUrlExpression.right);
  } else if (isEnvRead(baseUrlExpression)) {
    targetVariable = (baseUrlExpression as ts.PropertyAccessExpression).name.text;
  } else if (ts.isElementAccessExpression(baseUrlExpression)) {
    const argument = (baseUrlExpression as ts.ElementAccessExpression).argumentExpression;
    if (argument && ts.isStringLiteral(argument)) targetVariable = argument.text;
  } else {
    recordFallback(baseUrlExpression);
  }

  // Check-scoped overrides.
  let scopedProjects: string[] | null = null;
  let scopedRetries: number | null = null;
  let scopedTarget: string | null = null;
  if (checklyConfigSource) {
    const file = parse(checklyConfigSource);
    if (file) {
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "playwrightChecks") {
          if (ts.isArrayLiteralExpression(node.initializer)) {
            for (const entry of node.initializer.elements) {
              if (!ts.isObjectLiteralExpression(entry)) continue;
              const projects = stringArray(objectProperty(entry, "pwProjects"));
              if (projects) scopedProjects = [...new Set([...(scopedProjects ?? []), ...projects])];
              const retriesNode = objectProperty(entry, "retries");
              if (retriesNode) {
                const value = tryEvaluate(retriesNode, parse("null")!);
                if (typeof value === "number") scopedRetries = value;
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(file, visit);
    }
  }

  return {
    configPath: knownConfigPath ?? "playwright.config.ts",
    projects: (scopedProjects ?? (projectNames.length ? projectNames : null)),
    tags: null,
    testSelection: (scopedProjects ?? (projectNames.length ? projectNames : null)),
    retries: typeof scopedRetries === "number" ? scopedRetries : (typeof retries === "number" ? retries : null),
    targetVariable,
    targetFallback,
  };
}