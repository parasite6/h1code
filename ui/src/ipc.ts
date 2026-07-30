// Thin IPC layer: every backend call goes through here. No business logic.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WorkspaceInfo {
  root: string;
  name: string;
  has_pyproject: boolean;
  has_requirements_txt: boolean;
  has_local_venv: boolean;
  has_uv_lock: boolean;
  has_pytest_config: boolean;
  python: PythonEnv | null;
  project_name: string | null;
}

export interface PythonEnv {
  interpreter: string;
  version: string | null;
  source: "local_venv" | "uv" | "system" | "override";
  venv_root: string | null;
}

export interface DirEntry {
  path: string;
  name: string;
  is_dir: boolean;
}

export interface RecentProject {
  name: string;
  path: string;
  lastOpened: number;
}

export interface RuffDiagnostic {
  filename: string;
  code: string | null;
  message: string;
  location: { row: number; column: number };
  end_location: { row: number; column: number };
}

export type DiagSeverity = "error" | "warning" | "info" | "hint";

export interface CoreDiagnostic {
  severity: DiagSeverity;
  message: string;
  code: string | null;
  source: string | null;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export type CoreEvent =
  | { kind: "workspace_opened"; root: string }
  | { kind: "workspace_closed" }
  | { kind: "file_created"; path: string }
  | { kind: "file_modified"; path: string }
  | { kind: "file_removed"; path: string }
  | { kind: "file_renamed"; from: string; to: string }
  | { kind: "process_started"; id: string; cmd: string }
  | { kind: "process_output"; id: string; stream: "stdout" | "stderr"; line: string }
  | { kind: "process_exited"; id: string; code: number | null }
  | {
      kind: "diagnostics";
      path: string;
      source: string;
      items: CoreDiagnostic[];
    }
  | {
      kind: "search_index_status";
      phase: SearchIndexPhase;
      root: string | null;
      files_indexed: number;
      dirs_indexed: number;
      content_indexed: number;
      index_bytes: number;
      max_index_bytes: number;
      message: string | null;
    }
  | { kind: "log"; level: "debug" | "info" | "warn" | "error"; message: string };

export type SearchIndexPhase = "idle" | "indexing" | "ready" | "capped" | "error";

export interface SearchIndexStatus {
  phase: SearchIndexPhase;
  root: string | null;
  files_indexed: number;
  dirs_indexed: number;
  content_indexed: number;
  index_bytes: number;
  max_index_bytes: number;
  message: string | null;
}

export interface SearchQuery {
  pattern: string;
  literal?: boolean;
  case_insensitive?: boolean;
  include_hidden?: boolean;
  max_results?: number | null;
}

export interface PathHit {
  path: string;
  name: string;
  is_dir: boolean;
}

export interface SearchHit {
  path: string;
  line_number: number;
  line: string;
  start: number;
  end: number;
}

export interface SearchResponse {
  files: PathHit[];
  folders: PathHit[];
  content: SearchHit[];
}

export interface FileStat {
  exists: boolean;
  mtime_ms: number | null;
  size: number | null;
  is_dir: boolean | null;
}

export const ipc = {
  workspaceOpen: (path: string) =>
    invoke<WorkspaceInfo>("cmd_workspace_open", { path }),
  workspaceClose: () => invoke<void>("cmd_workspace_close"),
  workspaceInfo: () =>
    invoke<WorkspaceInfo | null>("cmd_workspace_info"),
  recentProjectsGet: () =>
    invoke<RecentProject[]>("cmd_recent_projects_get"),
  recentProjectsSet: (projects: RecentProject[]) =>
    invoke<void>("cmd_recent_projects_set", { projects }),
  workspaceLastActiveFileGet: (workspace: string) =>
    invoke<string | null>("cmd_workspace_last_active_file_get", {
      payload: { workspace },
    }),
  workspaceLastActiveFileSet: (workspace: string, file: string) =>
    invoke<void>("cmd_workspace_last_active_file_set", {
      payload: { workspace, file },
    }),
  workspaceOpenFilesGet: (workspace: string) =>
    invoke<string[]>("cmd_workspace_open_files_get", {
      payload: { workspace },
    }),
  workspaceOpenFilesSet: (workspace: string, files: string[]) =>
    invoke<void>("cmd_workspace_open_files_set", {
      payload: { workspace, files },
    }),
  fsList: (path: string) => invoke<DirEntry[]>("cmd_fs_list", { path }),
  fsRead: (path: string) => invoke<string>("cmd_fs_read", { path }),
  fsReadLossy: (path: string) => invoke<string>("cmd_fs_read_lossy", { path }),
  fsWrite: (path: string, contents: string) =>
    invoke<void>("cmd_fs_write", { path, contents }),
  fsCreateFile: (path: string) => invoke<void>("cmd_fs_create_file", { path }),
  fsCreateDir: (path: string) => invoke<void>("cmd_fs_create_dir", { path }),
  fsRename: (from: string, to: string) =>
    invoke<void>("cmd_fs_rename", { from, to }),
  fsRemove: (path: string) => invoke<void>("cmd_fs_remove", { path }),
  fsStat: (path: string) => invoke<FileStat>("cmd_fs_stat", { path }),
  search: (query: SearchQuery) =>
    invoke<SearchResponse>("cmd_search", { query }),
  searchStatus: () => invoke<SearchIndexStatus>("cmd_search_status"),
  pythonRun: (
    file: string,
    args: string[] = [],
    dims?: { cols: number; rows: number },
    cwd?: string
  ) =>
    invoke<{ id: string; interpreter: string }>("cmd_python_run", {
      payload: { file, args, cols: dims?.cols, rows: dims?.rows, cwd },
    }),
  ptyOpen: (dims?: { cols: number; rows: number }) =>
    invoke<{ id: string }>("cmd_pty_open", {
      payload: { cols: dims?.cols, rows: dims?.rows },
    }),
  processKill: (id: string) => invoke<boolean>("cmd_process_kill", { id }),
  ptyWrite: (id: string, data: string) => {
    if (localStorage.getItem("h1code.debug.terminalInput") === "1") {
      console.debug("[terminal-input] invoke cmd_pty_write", {
        id,
        length: data.length,
        escaped: escapeForLog(data),
        codes: Array.from(data).map((ch) => ch.codePointAt(0) ?? 0),
      });
    }
    return invoke<void>("cmd_pty_write", { id, data });
  },
  ptyResize: (id: string, cols: number, rows: number) =>
    invoke<void>("cmd_pty_resize", { id, cols, rows }),
  ptyClose: (id: string) => invoke<boolean>("cmd_pty_close", { id }),
  ruffCheck: (files: string[] = []) =>
    invoke<RuffDiagnostic[]>("cmd_ruff_check", { payload: { files } }),
  docDidOpen: (path: string, text: string) =>
    invoke<void>("cmd_doc_did_open", { path, text }),
  docDidChange: (path: string, text: string) =>
    invoke<void>("cmd_doc_did_change", { path, text }),
  docDidSave: (path: string, text?: string) =>
    invoke<void>("cmd_doc_did_save", { path, text }),
  docDidClose: (path: string) =>
    invoke<void>("cmd_doc_did_close", { path }),
};

function escapeForLog(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\x1b/g, "\\x1b")
    .replace(/\x03/g, "\\x03")
    .replace(/\x04/g, "\\x04");
}

export async function onCoreEvent(
  handler: (evt: CoreEvent) => void
): Promise<UnlistenFn> {
  return listen<CoreEvent>("core://event", (msg) => handler(msg.payload));
}
