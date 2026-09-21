// Where the Checkly credentials come from — the same two places the Checkly
// CLI itself looks (services/config.js in checkly@9.5.0):
//   1. environment: CHECKLY_API_KEY, CHECKLY_ACCOUNT_ID
//   2. the CLI's login files written by `npx checkly login`
//      (package `conf`, projectName "@checkly/cli", files auth.json + config.json)
//        macOS   ~/Library/Preferences/@checkly/cli/
//        Linux   $XDG_CONFIG_HOME/@checkly/cli/  (default ~/.config/@checkly/cli/)
//        Windows %APPDATA%\@checkly\cli\Config\
// Values are read, never printed and never written anywhere by verify-fix.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChecklyCredentials {
  apiKey: string;
  accountId: string;
  source: "env" | "checkly-cli-login" | "mixed";
}

export function checklyCliConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const suffix = env.CHECKLY_ENV ? `-${env.CHECKLY_ENV}` : "";
  const name = `@checkly/cli${suffix}`;
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === "darwin") return join(home, "Library", "Preferences", name);
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), name, "Config");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), name);
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ChecklyCredentials | null {
  const envKey = env.CHECKLY_API_KEY?.trim() || "";
  const envAccount = env.CHECKLY_ACCOUNT_ID?.trim() || "";
  if (envKey && envAccount) return { apiKey: envKey, accountId: envAccount, source: "env" };

  const dir = checklyCliConfigDir(env, platform);
  const auth = readJsonSafe(join(dir, "auth.json"));
  const data = readJsonSafe(join(dir, "config.json"));
  const fileKey = typeof auth?.apiKey === "string" ? (auth.apiKey as string) : "";
  const fileAccount = typeof data?.accountId === "string" ? (data.accountId as string) : "";

  const apiKey = envKey || fileKey;
  const accountId = envAccount || fileAccount;
  if (!apiKey || !accountId) return null;
  const source = envKey || envAccount ? "mixed" : "checkly-cli-login";
  return { apiKey, accountId, source };
}

export const CREDENTIALS_HELP =
  "No Checkly credentials found. Either export CHECKLY_API_KEY and CHECKLY_ACCOUNT_ID " +
  "(https://app.checklyhq.com/settings/user/api-keys), or run `npx checkly login` once — " +
  "verify-fix reads the same login files as the Checkly CLI.";
