# `<h1code>` - Bug Tracker

> Auto-maintained by Codex. Do not manually reorder entries.
> Statuses: `Open` | `Investigating` | `Needs confirmation` | `Fixed (unverified)` | `Resolved (verified)` | `Won't fix`

---

## Open Issues

- [ ] **BUG-2: Shell launcher reports `cmd_pty_open` not found** - `High`
  - **File**: `crates/ide-shell/src/main.rs` (line 68-75), `ui/src/ipc.ts` (line 86-89)
  - **Issue**: Pressing Shell invokes `cmd_pty_open`, but the running Tauri backend reports that the command is not registered.
  - **Probable cause**: The frontend bundle was updated, but the running `ide-shell.exe` was stale and did not contain the newly registered command.
  - **Fix**: Rebuild the actual Tauri desktop binary with `cargo build -p ide-shell` and restart the app so the backend command table includes `cmd_pty_open`.
  - **Evidence**: `rg -a "cmd_pty_open" target/debug/ide-shell.exe` failed before rebuilding and succeeded afterward.
  - **Status**: Fixed (unverified)

- [ ] **BUG-3: Workspace open shows phantom empty editor buffer** - `Medium`
  - **File**: `ui/src/main.ts` (line 63-75), `ui/index.html` (line 39-45), `ui/src/styles.css` (line 118-145)
  - **Issue**: Opening a workspace with no selected file shows CodeMirror's empty initial document, which looks like an unsaved unnamed file even though no real tab exists.
  - **Probable cause**: The editor is mounted immediately with an empty document and remains visible when `tabs.active()` is null.
  - **Fix**: Show a center empty state while no tab is active, hide/inactivate the editor host, and only reveal/remeasure CodeMirror after a real explorer file opens a real tab.
  - **Evidence**: Startup code mounts `mountEditor($("editor"), ...)` before any tab is opened; tab state remains empty until `tabs.open(path)`.
  - **Status**: Fixed (unverified)

- [ ] **BUG-4: Recent Projects do not persist after app relaunch** - `High`
  - **File**: `ui/src/main.ts` (line 153-220), `crates/ide-shell/src/main.rs` (line 144-210), `crates/ide-core/src/settings.rs` (line 91-102)
  - **Issue**: Recent Projects are visible while the app stays open but disappear after a full close/relaunch.
  - **Probable cause**: Runtime tracing proved persistence and hydration worked, but `renderEmptyState()` aborted because it queried `id="empty-state-shortcuts"` while the DOM element only had class `.empty-state-shortcuts`; the recent section stayed hidden and the list was never populated.
  - **Fix**: Use the existing `.empty-state-shortcuts` selector, keep Recent Projects as user-level persisted state, render immediately after hydration, and leave only gated console diagnostics.
  - **Evidence**: Relaunch trace before the fix showed backend returned one project and frontend loaded it, then skipped render with `hasShortcutsSection:false`; after the selector fix the trace showed `listChildren:1`, `recentSectionHidden:false`, `shortcutsHidden:true`, and `editorEmptyStateHidden:false`.
  - **Status**: Fixed (unverified)

- [ ] **BUG-5: Window close button is blocked by denied destroy permission** - `High`
  - **File**: `ui/src/main.ts` (close handler), `crates/ide-shell/capabilities/default.json`
  - **Issue**: Pressing the native window X does not close the IDE.
  - **Probable cause**: The close handler synchronously calls `event.preventDefault()` for every close request, then calls `appWindow.destroy()` after unsaved-change checks; the Tauri capability file granted `core:window:default` but not `core:window:allow-destroy`, so the manual close path was denied after the native close was already blocked.
  - **Fix**: Grant `core:window:allow-destroy` and log any future manual destroy failures.
  - **Evidence**: Source inspection showed the always-prevent close handler and missing destroy capability; after rebuilding, a runtime `CloseMainWindow()` verification exited the app with code 0.
  - **Status**: Fixed (unverified)

- [ ] **BUG-6: Startup New File/New Folder opens filesystem dialogs too early** - `Medium`
  - **File**: `ui/src/main.ts`, `ui/src/explorer.ts`, `ui/src/tabs.ts`, `ui/src/modal.ts`
  - **Issue**: The start-screen New File/New Folder quick actions immediately opened native filesystem dialogs instead of letting users create temporary in-IDE work first.
  - **Probable cause**: The quick actions were wired directly to `saveDialog` plus `fsCreateFile` / `fsCreateDir`, so creation was filesystem-first rather than scratch-first.
  - **Fix**: Add in-IDE naming prompts, temporary file tabs, a frontend-only scratch explorer mode, and deferred save behavior that writes temporary work only when the user saves or confirms close/switch.
  - **Evidence**: `npm run build` and `cargo check` pass after replacing the startup quick-action path with temporary-first creation.
  - **Status**: Fixed (unverified)

- [ ] **BUG-7: Explorer actions lack complete temporary and filesystem item operations** - `Medium`
  - **File**: `ui/src/explorer.ts`, `ui/src/main.ts`, `ui/src/ipc.ts`, `crates/ide-shell/src/main.rs`
  - **Issue**: Sidebar New File/New Folder did nothing without an active workspace, temporary nested folder creation was fragile, and explorer context menus lacked Rename/Delete.
  - **Probable cause**: Sidebar buttons only called `explorer.beginCreate()` when an existing workspace object was present; scratch tree mutation stayed local to create-only paths; backend rename/remove existed in `FsService` but had no Tauri command wiring.
  - **Fix**: Route sidebar buttons through shared temp/scratch helpers, preserve scratch selection while nesting, add Rename/Delete context actions, wire `cmd_fs_rename` / `cmd_fs_remove`, and synchronize open tabs on rename/delete.
  - **Evidence**: `npm run build` and `cargo check` pass after adding explorer rename/delete and scratch nesting refinements.
  - **Status**: Fixed (unverified)

- [ ] **BUG-8: Explorer folder collapse leaves stale active creation context** - `Medium`
  - **File**: `ui/src/explorer.ts`
  - **Issue**: Newly created temporary folders auto-expanded and then became the active creation parent, so later toolbar New File/New Folder actions stayed pinned inside that first folder.
  - **Probable cause**: Scratch folder creation both expanded the new folder and assigned `scratchSelectedDir = entry.path`; additionally, the scratch root render path was hard-coded as expanded, always rendered children, and had no root caret toggle handler.
  - **Fix**: Keep auto-expanded folders visually open while leaving `scratchSelectedDir` on the parent/root, separate caret toggle clicks from folder-row selection, make the scratch root reconcile against `scratchExpanded`, and add gated explorer-tree traces for collapse verification.
  - **Evidence**: `npm run build`, `cargo check`, and `cargo build -p ide-shell` pass after the focused collapse/context-state fix.
  - **Status**: Fixed (unverified)

## Needs Confirmation

## Resolved Issues

- [x] **BUG-1: Terminal printable input does not reach active PTY** - `High`
  - **File**: `ui/src/terminal.ts` (line 60-84), `ui/src/ipc.ts` (line 91-99), `crates/ide-shell/src/main.rs` (line 254), `crates/ide-core/src/pty.rs` (line 129)
  - **Issue**: The terminal textarea receives focus, but typing letters in the shell/REPL does not appear, so the failure is in the runtime input path after DOM focus.
  - **Probable cause**: Keyboard input may be suppressed by the xterm custom key handler, dropped because no active session id is attached, blocked at `cmd_pty_write`, or lost in the PTY writer path.
  - **Fix**: Instrument `onData`, frontend `ptyWrite`, `cmd_pty_write`, and `PtyManager::write`; bypass the custom key handler by default until normal printable input is verified.
  - **Evidence**: User confirmed interactive PTY input now works correctly when running Python files.
  - **Status**: Resolved (verified)
  - **Resolution**: Runtime PTY input path is functioning for Python-file PTY sessions; remaining Shell failure is separate command registration/runtime binary issue tracked as BUG-2.

## Won't Fix / Intended Behavior
