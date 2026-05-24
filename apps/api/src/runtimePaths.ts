import path from "node:path";
import { fileURLToPath } from "node:url";

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function workspaceRootDir(): string {
  const override = process.env.REPO_INSPECTOR_ROOT_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.resolve(moduleDir(), "..", "..", "..");
}

