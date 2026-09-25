import { spawn } from "node:child_process";
import path from "node:path";
import ts from "typescript";

export interface SetupRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  queryParameters: Record<string, string>;
}

export interface SetupExecution {
  ok: boolean;
  request: SetupRequest | null;
  error: string | null;
  logs: string[];
}

function norm(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

const CHILD = String.raw`
const vm = require('node:vm');
const path = require('node:path').posix;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  let payload;
  try { payload = JSON.parse(input); } catch { process.stdout.write(JSON.stringify({ok:false,error:'invalid sandbox payload',request:null,logs:[]})); return; }
  const logs = [];
  const safeConsole = Object.freeze({
    log: (...args) => logs.push(args.map(value => typeof value === 'string' ? value : '[value]').join(' ').slice(0, 300)),
    info: (...args) => logs.push(args.map(value => typeof value === 'string' ? value : '[value]').join(' ').slice(0, 300)),
    warn: (...args) => logs.push(args.map(value => typeof value === 'string' ? value : '[value]').join(' ').slice(0, 300)),
    error: (...args) => logs.push(args.map(value => typeof value === 'string' ? value : '[value]').join(' ').slice(0, 300)),
  });
  const context = vm.createContext({ request: payload.request, process: Object.freeze({ env: Object.freeze(payload.env) }), console: safeConsole });
  const cache = new Map();
  const candidates = (from, spec) => {
    const base = path.normalize(path.join(path.dirname(from), spec));
    return [base, base+'.js', base+'.ts', base+'.tsx', path.join(base,'index.js'), path.join(base,'index.ts')];
  };
  const resolve = (from, spec) => {
    if (!spec.startsWith('.')) throw new Error('unsupported setup import: '+spec);
    const found = candidates(from, spec).find(file => Object.prototype.hasOwnProperty.call(payload.modules, file));
    if (!found) throw new Error('setup import not captured: '+spec);
    return found;
  };
  const load = (id, root = false) => {
    if (cache.has(id)) return cache.get(id).exports;
    if (!Object.prototype.hasOwnProperty.call(payload.modules, id)) throw new Error('setup module not captured: '+id);
    const module = { exports: {} };
    cache.set(id, module);
    const requireLocal = spec => load(resolve(id, spec), false);
    const prefix = root ? '(async function(exports,module,require,__filename,__dirname){' : '(function(exports,module,require,__filename,__dirname){';
    const script = new vm.Script(prefix + payload.modules[id] + '\n})', { filename: id });
    const fn = script.runInContext(context, { timeout: 1000 });
    const result = fn(module.exports, module, requireLocal, id, path.dirname(id));
    return root ? Promise.resolve(result).then(() => module.exports) : module.exports;
  };
  try {
    await load(payload.entry, true);
    process.stdout.write(JSON.stringify({ok:true,request:payload.request,error:null,logs}));
  } catch (error) {
    process.stdout.write(JSON.stringify({ok:false,request:null,error:String(error && error.message || error).slice(0,500),logs}));
  }
});
`;

function redactSetupText(text: string | null, env: Record<string, string>): string | null {
  if (text === null) return null;
  let output = text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  for (const value of Object.values(env).filter((item) => item.length >= 3)) output = output.split(value).join("[REDACTED]");
  return output;
}

export async function runSetupScript(
  entryFile: string,
  files: Map<string, string>,
  request: SetupRequest,
  env: Record<string, string>,
  timeoutMs = 3_000,
): Promise<SetupExecution> {
  const modules: Record<string, string> = {};
  for (const [rawFile, source] of files) {
    const file = norm(rawFile);
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    modules[file] = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: file,
      reportDiagnostics: false,
    }).outputText;
  }
  const entry = norm(entryFile);
  if (!modules[entry]) return { ok: false, request: null, error: `setup script ${entry} is missing`, logs: [] };
  const payload = JSON.stringify({ entry, modules, request, env });
  return await new Promise<SetupExecution>((resolveResult) => {
    const child = spawn(process.execPath, ["--permission", "-e", CHILD], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: SetupExecution) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish({ ok: false, request: null, error: `setup script exceeded ${timeoutMs}ms`, logs: [] });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish({ ok: false, request: null, error: error.message, logs: [] }));
    child.on("close", () => {
      if (settled) return;
      try {
        const result = JSON.parse(stdout) as SetupExecution;
        finish({
          ...result,
          error: redactSetupText(result.error, env),
          logs: result.logs.map((line) => redactSetupText(line, env) ?? ""),
        });
      } catch {
        finish({ ok: false, request: null, error: `setup sandbox produced no structured result${stderr ? ` (${stderr.slice(0, 200)})` : ""}`, logs: [] });
      }
    });
    child.stdin.end(payload);
  });
}

export function requestPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

export function sameRequestIdentity(before: SetupRequest, after: SetupRequest): boolean {
  return before.method === after.method && requestPath(before.url) === requestPath(after.url) && before.body === after.body && JSON.stringify(before.queryParameters) === JSON.stringify(after.queryParameters);
}

export function resolveSetupPath(checkFile: string, setupFile: string): string {
  return norm(path.posix.normalize(path.posix.isAbsolute(setupFile) ? setupFile : path.posix.join(path.posix.dirname(checkFile), path.posix.basename(setupFile))));
}
