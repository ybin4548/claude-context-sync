import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const DECLARATION_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^\s*(?:export\s+)?class\s+(\w+)/,
    /^\s*(?:export\s+)?interface\s+(\w+)/,
    /^\s*(?:export\s+)?type\s+(\w+)/,
    /^\s*(?:export\s+)?enum\s+(\w+)/,
    /^\s*(?:export\s+)?const\s+(\w+)\s*=/,
    /^\s*(?:public|private|protected|static|async)\s+(?:async\s+)?(\w+)\s*\(/,
  ],
  python: [
    /^\s*(?:async\s+)?def\s+(\w+)/,
    /^\s*class\s+(\w+)/,
  ],
  swift: [
    /^\s*(?:public|private|internal|open|fileprivate)?\s*(?:override\s+)?(?:static\s+)?func\s+(\w+)/,
    /^\s*(?:public|private|internal|open|fileprivate)?\s*class\s+(\w+)/,
    /^\s*(?:public|private|internal|open|fileprivate)?\s*struct\s+(\w+)/,
    /^\s*(?:public|private|internal|open|fileprivate)?\s*protocol\s+(\w+)/,
    /^\s*(?:public|private|internal|open|fileprivate)?\s*enum\s+(\w+)/,
    /^\s*(?:public|private|internal|open|fileprivate)?\s*extension\s+(\w+)/,
  ],
  go: [
    /^\s*func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/,
    /^\s*type\s+(\w+)\s+(?:struct|interface)/,
  ],
  rust: [
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
    /^\s*(?:pub\s+)?struct\s+(\w+)/,
    /^\s*(?:pub\s+)?enum\s+(\w+)/,
    /^\s*(?:pub\s+)?trait\s+(\w+)/,
    /^\s*impl(?:<[^>]*>)?\s+(\w+)/,
  ],
};

const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".py": "python",
  ".swift": "swift",
  ".go": "go",
  ".rs": "rust",
};

function getLanguage(filePath: string): string | null {
  return EXT_TO_LANGUAGE[extname(filePath)] ?? null;
}

function findEnclosingSymbol(
  lines: string[],
  editLineIndex: number,
  patterns: RegExp[],
): string | null {
  for (let i = editLineIndex; i >= 0; i--) {
    for (const pattern of patterns) {
      const match = lines[i].match(pattern);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

export async function resolveSymbol(
  filePath: string,
  editSnippet: string,
): Promise<string | null> {
  const language = getLanguage(filePath);
  if (!language) return null;

  const patterns = DECLARATION_PATTERNS[language];
  if (!patterns) return null;

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  const firstLine = editSnippet.split("\n")[0].trim();
  if (!firstLine) return null;

  const editLineIndex = lines.findIndex((l) => l.includes(firstLine));
  if (editLineIndex === -1) return null;

  return findEnclosingSymbol(lines, editLineIndex, patterns);
}
