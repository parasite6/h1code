import { ipc, type DirEntry, type WorkspaceInfo } from "./ipc";
import type { Tab } from "./tabs";

const ENTRYPOINT_NAMES = new Set(["main.py", "app.py", "run.py", "manage.py", "cli.py", "__main__.py"]);
const SKIP_DIRS = new Set([".git", ".venv", "venv", "node_modules", "target", "dist", "build", "__pycache__"]);

function shouldSkipDir(name: string) {
  return SKIP_DIRS.has(name.toLowerCase());
}
const MAX_CANDIDATE_READS = 24;

export interface RunTargetSuggestion {
  path: string;
  label: string;
  reason: string;
}

export interface RunTargetDecision {
  shouldPrompt: boolean;
  suggestion: RunTargetSuggestion | null;
}

interface Candidate {
  path: string;
  name: string;
  rank: number;
  reason: string;
}

export async function chooseRunTarget(
  active: Tab,
  activeText: string,
  workspace: WorkspaceInfo | null
): Promise<RunTargetDecision> {
  if (isSuppressed(active.path)) return { shouldPrompt: false, suggestion: null };
  if (isClearlyRunnable(active.path, activeText)) return { shouldPrompt: false, suggestion: null };

  const suggestion = await findEntrypointCandidate(active.path, workspace);
  return { shouldPrompt: suggestion !== null, suggestion };
}

export function rememberRunTarget(workspace: WorkspaceInfo | null, path: string) {
  if (!workspace) return;
  const key = recentKey(workspace.root);
  const existing = readJson<string[]>(key, []);
  const normalized = normPath(path);
  const next = [path, ...existing.filter((item) => normPath(item) !== normalized)].slice(0, 8);
  localStorage.setItem(key, JSON.stringify(next));
}

export function suppressRunPrompt(path: string) {
  const suppressed = readJson<string[]>("h1code.runPrompt.suppressedFiles", []);
  const normalized = normPath(path);
  if (!suppressed.some((item) => normPath(item) === normalized)) {
    localStorage.setItem("h1code.runPrompt.suppressedFiles", JSON.stringify([...suppressed, path]));
  }
}

function isSuppressed(path: string) {
  const suppressed = readJson<string[]>("h1code.runPrompt.suppressedFiles", []);
  const normalized = normPath(path);
  return suppressed.some((item) => normPath(item) === normalized);
}

function isClearlyRunnable(path: string, text: string) {
  const name = basename(path).toLowerCase();
  return isPython(path) && (ENTRYPOINT_NAMES.has(name) || name.endsWith("main.py") || hasMainGuard(text));
}

async function findEntrypointCandidate(
  activePath: string,
  workspace: WorkspaceInfo | null
): Promise<RunTargetSuggestion | null> {
  if (!workspace) return null;
  const activeNorm = normPath(activePath);
  const candidates = await collectCandidates(workspace);
  const recent = recentCandidates(workspace, activeNorm);
  const all = [...recent, ...candidates].filter((candidate) => normPath(candidate.path) !== activeNorm);
  if (all.length === 0) return null;

  all.sort((a, b) => a.rank - b.rank || pathDepth(a.path) - pathDepth(b.path) || a.path.localeCompare(b.path));
  const best = all[0];
  return {
    path: best.path,
    label: relativeToWorkspace(best.path, workspace.root),
    reason: best.reason,
  };
}

async function collectCandidates(workspace: WorkspaceInfo): Promise<Candidate[]> {
  const rootEntries = await safeList(workspace.root);
  const firstLevelDirs = rootEntries.filter((entry) => entry.is_dir && !shouldSkipDir(entry.name));
  const files = rootEntries.filter((entry) => !entry.is_dir);

  for (const dir of firstLevelDirs) {
    const children = await safeList(dir.path);
    files.push(...children.filter((entry) => !entry.is_dir));
  }

  const pythonFiles = files.filter((entry) => isPython(entry.path));
  const candidates: Candidate[] = [];
  let contentReads = 0;

  for (const file of pythonFiles) {
    const name = file.name.toLowerCase();
    if (ENTRYPOINT_NAMES.has(name) || name.endsWith("main.py")) {
      candidates.push({
        path: file.path,
        name,
        rank: nameRank(name),
        reason: `${file.name} is a conventional Python entrypoint name.`,
      });
      continue;
    }

    if (contentReads >= MAX_CANDIDATE_READS) continue;
    contentReads += 1;
    const text = await safeRead(file.path);
    if (text && hasMainGuard(text)) {
      candidates.push({
        path: file.path,
        name,
        rank: 20 + pathDepth(file.path),
        reason: `${file.name} has a __main__ guard.`,
      });
    }
  }

  return candidates;
}

function recentCandidates(workspace: WorkspaceInfo, activeNorm: string): Candidate[] {
  return readJson<string[]>(recentKey(workspace.root), [])
    .filter((path) => normPath(path) !== activeNorm && isPython(path))
    .map((path, index) => ({
      path,
      name: basename(path),
      rank: 5 + index,
      reason: `${basename(path)} was run recently in this workspace.`,
    }));
}

function hasMainGuard(text: string) {
  return /if\s+__name__\s*==\s*["']__main__["']\s*:/.test(text);
}

function isPython(path: string) {
  return path.toLowerCase().endsWith(".py");
}

function nameRank(name: string) {
  switch (name) {
    case "main.py":
      return 0;
    case "app.py":
      return 1;
    case "run.py":
      return 2;
    case "manage.py":
      return 3;
    case "cli.py":
      return 4;
    case "__main__.py":
      return 5;
    default:
      return 10;
  }
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function pathDepth(path: string) {
  return path.split(/[\\/]/).length;
}

function normPath(path: string) {
  return path.replace(/\\/g, "/").toLowerCase();
}

function relativeToWorkspace(path: string, root: string) {
  const normalizedRoot = root.replace(/\\/g, "/");
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase() + "/")) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return basename(path);
}

function recentKey(root: string) {
  return `h1code.runPrompt.recent:${normPath(root)}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

async function safeList(path: string): Promise<DirEntry[]> {
  try {
    return await ipc.fsList(path);
  } catch {
    return [];
  }
}

async function safeRead(path: string) {
  try {
    return await ipc.fsRead(path);
  } catch {
    return null;
  }
}
