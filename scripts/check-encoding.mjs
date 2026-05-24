import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const roots = ["apps/api/src", "apps/web/src", "scripts"];
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".css",
  ".html"
]);

const suspiciousChars = new Set([
  "锟",
  "浠",
  "撳",
  "簱",
  "鎺",
  "缁",
  "鐢",
  "瀹",
  "鍔",
  "璁",
  "琛",
  "浣",
  "淇",
  "鍙",
  "鍚",
  "鏃",
  "鍒",
  "浜",
  "妯",
  "鏌",
  "绾",
  "闄",
  "澶",
  "寤",
  "娆",
  "脦",
  "脨",
  "脠",
  "脡",
  "脢",
  "脣"
]);

function isTextFile(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith("dockerfile")) {
    return true;
  }
  return textExtensions.has(path.extname(lower));
}

async function listFiles(root) {
  const results = [];
  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (entry.isFile() && isTextFile(absolute)) {
        results.push(absolute);
      }
    }
  }
  await walk(root);
  return results;
}

function collectFindings(content, filePath) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    if (line.includes("\uFFFD") || /\?{3,}/.test(line)) {
      findings.push(`${filePath}:${index + 1}: replacement characters or question-mark runs detected`);
      continue;
    }

    let suspiciousCount = 0;
    for (const char of line) {
      if (suspiciousChars.has(char)) {
        suspiciousCount += 1;
      }
    }
    if (suspiciousCount >= 4 && line.length <= 180) {
      findings.push(`${filePath}:${index + 1}: probable mojibake (${suspiciousCount} suspicious characters)`);
    }
  }
  return findings;
}

const findings = [];

for (const root of roots) {
  const files = await listFiles(root);
  for (const filePath of files) {
    const content = await readFile(filePath, "utf8").catch(() => "");
    findings.push(...collectFindings(content, filePath));
  }
}

if (findings.length > 0) {
  for (const item of findings.slice(0, 200)) {
    console.error(item);
  }
  console.error(`Encoding check failed: ${findings.length} suspicious line(s) detected.`);
  process.exit(1);
}

console.log("Encoding check passed.");
