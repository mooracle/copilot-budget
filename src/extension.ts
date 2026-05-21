import * as path from 'path';
import * as vscode from 'vscode';
import { Tracker, JsonlSource, OTelSource, Source } from './tracker';
import { createStatusBar } from './statusBar';
import { showBudgetPanel } from './budgetPanel';
import {
  writeTrackingFile,
  readTrackingFile,
  isTrackingFileTruncated,
} from './trackingFile';
import { installHook, uninstallHook } from './commitHook';
import {
  isEnabled,
  isCommitHookEnabled,
  onConfigChanged,
  getEstimationMode,
  isOTelDbExporterEnabled,
  onDidChangeOTelSetting,
} from './config';
import { discoverSessionFiles, getDiscoveryDiagnostics } from './sessionDiscovery';
import {
  createOTelReader,
  diagnoseUnavailable,
  OTelReader,
} from './otelReader';
import { getOutputChannel, disposeLogger, log } from './logger';

const MODE_SWAP_SHOWN_KEY = 'copilot-budget.modeSwapMessageShown';

function resolveCurrentSessionIds(storageUri: vscode.Uri | undefined): string[] {
  return discoverSessionFiles(storageUri).map((p) =>
    path.basename(p).replace(/\.jsonl$/i, ''),
  );
}

interface PickedSource {
  source: Source;
  mode: 'files' | 'telemetry';
}

function pickSource(
  context: vscode.ExtensionContext,
  sessionIdsFn: () => string[],
): PickedSource {
  // Re-create the reader each pick so the previous source (and its reader, if
  // any) can be cleanly disposed before we evaluate availability again. The
  // file-existence check inside `getEstimationMode` is cheap.
  const reader: OTelReader = createOTelReader(context.globalStorageUri);
  const upstreamEnabled = isOTelDbExporterEnabled();
  const mode = getEstimationMode(reader, upstreamEnabled);
  if (mode === 'telemetry') {
    try {
      // `new OTelSource` calls `reader.getLatestTimestamp()` which opens the
      // SQLite DB. A corrupted or partially-written DB throws here. Without
      // this guard, activation (and the hot-swap listener) would die outright
      // and the reader handle would leak. Close it and fall back to Files mode
      // so the extension stays usable.
      return { source: new OTelSource(reader, sessionIdsFn), mode: 'telemetry' };
    } catch (err) {
      log(`Failed to open OTel DB, falling back to Files mode: ${String(err)}`);
      reader.close();
      return { source: new JsonlSource(context.storageUri), mode: 'files' };
    }
  }
  // Files mode — log the remote-host mismatch diagnostic if relevant, then
  // release the reader handle (we don't need it).
  const diag = diagnoseUnavailable(context.globalStorageUri, upstreamEnabled);
  if (diag) log(diag);
  reader.close();
  return {
    source: new JsonlSource(context.storageUri),
    mode: 'files',
  };
}

let tracker: Tracker | null = null;
let statusBar: { item: vscode.StatusBarItem; dispose: () => void } | null =
  null;
let consumeInFlight: Promise<boolean> | null = null;

// Detect commit-hook truncation and rebase the tracker so the next commit
// only reports activity that wasn't already in the consumed trailer.
// `tracker.consume()` keeps post-commit (and pre-commit-but-unwritten)
// activity as the next delta — a full reset would absorb it into the new
// baseline and silently underreport. Returns true when a rebase happened so
// callers can skip writing stale cumulative stats over the freshly written
// post-rebase file.
//
// Concurrency: only the consume-and-write step is memoized. The truncation
// probe is run fresh per caller so a slow-filesystem race can't latch a
// stale `false`: if caller A's stat ran pre-truncation and resolved to false,
// memoizing that result would cause a caller B arriving post-truncation to
// reuse A's stale answer and write pre-consume stats over the truncated
// signal. Memoizing only the consume step keeps overlapping positive callers
// from running two parallel rebases against the same source.
function checkCommitReset(): Promise<boolean> {
  if (!tracker) return Promise.resolve(false);
  return (async () => {
    if (!tracker) return false;
    // Always re-probe truncation; never share a negative result across
    // callers. See concurrency note above.
    if (!(await isTrackingFileTruncated())) return false;
    if (!tracker) return false;
    if (consumeInFlight) return consumeInFlight;
    consumeInFlight = (async () => {
      try {
        if (!tracker) return false;
        // consume() can bail without rebasing if a source swap lands during
        // its awaits. In that case lastStats still holds the pre-truncation
        // cumulative totals (swapSource carried them into previousStats), so
        // writing them back would re-introduce the trailers the hook just
        // consumed and double count on the next commit. We still return
        // `true` so overlapping/periodic callers skip writing their own
        // pre-consume snapshots; the tracking file stays truncated and the
        // next 5s poll retries.
        const rebased = await tracker.consume();
        if (!rebased) {
          log('Tracking file truncated but consume() bailed (source swap); next poll will retry');
          return true;
        }
        log('Tracking file truncated by commit hook — stats rebased to last snapshot');
        if (tracker) {
          await writeTrackingFile(tracker.getStats()).catch(() => {});
        }
        return true;
      } finally {
        consumeInFlight = null;
      }
    })();
    return consumeInFlight;
  })();
}

const ALL_COMMANDS = [
  'copilot-budget.showStats',
  'copilot-budget.resetTracking',
  'copilot-budget.installHook',
  'copilot-budget.uninstallHook',
  'copilot-budget.toggleCommitHook',
  'copilot-budget.showDiagnostics',
];

const EMPTY_WINDOW_MESSAGE =
  'Copilot Budget: no workspace open. Open a folder to track Copilot usage.';

function registerShowDiagnostics(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.showDiagnostics', async () => {
      const ch = getOutputChannel();
      const diag = getDiscoveryDiagnostics(context.storageUri);

      ch.appendLine('=== Copilot Budget Diagnostics ===');
      ch.appendLine(`Platform: ${diag.platform}`);
      ch.appendLine(`Home directory: ${diag.homedir}`);
      ch.appendLine('');
      ch.appendLine(`Storage URI: ${diag.storageUri ?? '(none — empty window)'}`);
      ch.appendLine(`Chat sessions dir: ${diag.chatSessionsDir ?? '(none — empty window)'}`);
      ch.appendLine('');
      ch.appendLine(`Session files found: ${diag.filesFound.length}`);
      for (const f of diag.filesFound) {
        ch.appendLine(`  ${f}`);
      }

      if (tracker) {
        // Force a fresh scan so the per-file breakdown reflects what's on
        // disk right now, not whatever was cached up to ~30s ago. A scan
        // failure (e.g., transient OTel DB error) shouldn't break the
        // diagnostics output — fall back to the last cached stats.
        try {
          await tracker.update();
        } catch (err) {
          log(`showDiagnostics: tracker.update failed: ${String(err)}`);
        }
        const stats = tracker.getStats();
        ch.appendLine('');
        ch.appendLine('Current stats:');
        ch.appendLine(`  Total tokens: ${stats.totalTokens}`);
        ch.appendLine(`  Interactions: ${stats.interactions}`);
        ch.appendLine(`  AI Credits: ${stats.totalAiCredits.toFixed(2)}`);
        ch.appendLine(`  Since: ${stats.since}`);
        ch.appendLine(`  Last updated: ${stats.lastUpdated}`);

        const perFile = tracker.getFileDiagnostics();
        ch.appendLine('');
        ch.appendLine(`Per-file breakdown (${perFile.length} file(s)):`);
        for (const f of perFile) {
          ch.appendLine(`  ${f.path}`);
          ch.appendLine(`    mtime: ${new Date(f.mtime).toISOString()}`);
          ch.appendLine(
            `    in baseline: ${f.inBaseline ? 'yes (pre-session content folded into baseline)' : 'no (entire file counts toward session delta)'}`,
          );
          ch.appendLine(`    interactions: ${f.interactions}`);
          const models = Object.entries(f.modelUsage);
          if (models.length === 0) {
            ch.appendLine('    models: (none)');
          } else {
            for (const [model, tokens] of models) {
              const total =
                tokens.inputTokens +
                tokens.outputTokens +
                tokens.cacheReadTokens +
                tokens.cacheCreationTokens;
              const turns = f.modelInteractions[model] ?? 0;
              ch.appendLine(
                `    ${model}: ${total} tokens across ${turns} turn(s) ` +
                  `(in=${tokens.inputTokens}, out=${tokens.outputTokens}, ` +
                  `cr=${tokens.cacheReadTokens}, cc=${tokens.cacheCreationTokens})`,
              );
            }
          }
        }
      }

      ch.show();
    }),
  );
}

function activateEmptyWindow(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(
    'copilot-budget.statusBar',
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.name = 'Copilot Budget';
  item.text = '$(circle-slash) Copilot Budget';
  item.tooltip = 'No workspace open — open a folder to track Copilot usage.';
  item.command = 'copilot-budget.showDiagnostics';
  item.show();
  context.subscriptions.push(item);

  const infoHandler = () => vscode.window.showInformationMessage(EMPTY_WINDOW_MESSAGE);
  for (const cmd of ALL_COMMANDS) {
    if (cmd === 'copilot-budget.showDiagnostics') continue;
    context.subscriptions.push(vscode.commands.registerCommand(cmd, infoHandler));
  }

  registerShowDiagnostics(context);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!isEnabled()) {
    const handler = () =>
      vscode.window.showInformationMessage(
        'Copilot Budget is disabled. Enable it via the copilot-budget.enabled setting.',
      );
    for (const cmd of ALL_COMMANDS) {
      context.subscriptions.push(
        vscode.commands.registerCommand(cmd, handler),
      );
    }
    return;
  }

  if (!context.storageUri) {
    activateEmptyWindow(context);
    return;
  }

  const sessionIdsFn = () => resolveCurrentSessionIds(context.storageUri);
  const picked = pickSource(context, sessionIdsFn);
  tracker = new Tracker(picked.source, picked.mode);
  log(`Estimation mode at activation: ${picked.mode}`);

  // Restore stats from previous session (if tracking file exists)
  const trackingFile = await readTrackingFile();
  if (trackingFile.kind === 'restored') {
    tracker.setPreviousStats(trackingFile.stats);
    log('Restored stats from previous session');
  } else if (trackingFile.kind === 'legacy') {
    log('Tracking file has legacy v0.5.x content, will overwrite');
  } else {
    log('No previous stats to restore');
  }

  // Kick off the initial scan in the background so activation doesn't hang
  // on accounts with many historical chats. The status bar shows zero (or
  // restored stats from setPreviousStats) until baseline lands and listeners
  // fire. Legacy-file overwrite chains onto start so the new schema is
  // written once we have real numbers — until then the legacy file remains
  // and is ignored by the hook (it lacks TOTAL_AI_CREDITS).
  const startPromise = tracker.start();

  if (trackingFile.kind === 'legacy') {
    startPromise
      .then(() => tracker && writeTrackingFile(tracker.getStats()).catch(() => {}))
      .catch(() => {});
  }
  startPromise.catch(() => {});

  statusBar = createStatusBar(tracker);
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Write tracking file whenever stats change. Check for hook truncation
  // first: if the hook just consumed accumulated trailers, the tracker must
  // be reset so the next write doesn't re-emit stale TR_ lines. Re-read
  // tracker.getStats() post-await so a reset that landed mid-flight is
  // reflected in what gets written.
  const statsWriter = tracker.onStatsChanged(() => {
    checkCommitReset().then((wasReset) => {
      if (wasReset || !tracker) return;
      writeTrackingFile(tracker.getStats()).catch(() => {});
    }).catch(() => {});
  });
  context.subscriptions.push(statsWriter);

  // Poll for hook-induced truncation on a short interval. Without this, a
  // truncation between stats-change events would only be noticed on the next
  // session-file change, leaving the in-memory tracker out of sync with the
  // on-disk "consumed" signal. When no truncation is detected we still re-
  // write current stats so external readers (status bar consumers, manual
  // file inspection) see a fresh snapshot.
  const trackingFileRefresh = setInterval(() => {
    if (!tracker) return;
    checkCommitReset().then((wasReset) => {
      if (tracker && !wasReset) writeTrackingFile(tracker.getStats()).catch(() => {});
    }).catch(() => {});
  }, 5_000);
  context.subscriptions.push({ dispose: () => clearInterval(trackingFileRefresh) });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.showStats', () => {
      if (tracker) {
        showBudgetPanel({ tracker }).catch((err) =>
          log(`showBudgetPanel failed: ${String(err)}`),
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.resetTracking', async () => {
      if (tracker) {
        await tracker.reset();
        vscode.window.showInformationMessage('Copilot Budget: Tracking reset.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.installHook', async () => {
      await installHook();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.uninstallHook', async () => {
      await uninstallHook();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-budget.toggleCommitHook', async () => {
      // Hook action first; persist setting only on success. See
      // budgetPanel.handleHookToggle for the rationale — the setting and
      // disk state must stay in sync or we re-attempt failing installs on
      // every later config change. The settings write can also fail (locked
      // settings.json, Sync provider error); warn the user when it does so
      // they know disk and config have drifted.
      const newState = !isCommitHookEnabled();
      const succeeded = newState ? await installHook() : await uninstallHook();
      if (!succeeded) return;
      try {
        await vscode.workspace
          .getConfiguration('copilot-budget')
          .update('commitHook.enabled', newState, vscode.ConfigurationTarget.Global);
      } catch {
        vscode.window.showWarningMessage(
          `Copilot Budget: Hook ${newState ? 'installed' : 'removed'}, but failed to save the commitHook.enabled setting — disk state and setting may now disagree.`,
        );
      }
    }),
  );

  registerShowDiagnostics(context);

  // Auto-install/refresh hook if enabled in settings (only when a workspace is open)
  if (isCommitHookEnabled() && vscode.workspace.workspaceFolders?.length) {
    installHook().catch(() => {});
  }

  // Listen for config changes
  const configSub = onConfigChanged(() => {
    if (isCommitHookEnabled()) {
      installHook().catch(() => {});
    }
  });
  context.subscriptions.push(configSub);

  // Re-pick the source and swap if the effective mode changed. Used both by
  // the upstream-setting change listener and the periodic re-eval poll
  // (DB-materializes-later recovery). We re-evaluate `getEstimationMode`
  // (which checks the upstream setting AND file presence) rather than
  // blindly trusting the change event — the setting can be true while the
  // DB is missing on remote-host setups, in which case we stay in Files mode
  // and log the diagnostic.
  //
  // Serialized via swapChain: concurrent triggers (rapid setting flips, or
  // the 30s auto-upgrade poll overlapping a manual toggle) would otherwise
  // start parallel swapSource calls — the slower one finishing last would
  // overwrite `tracker.mode`/`tracker.source` back to a stale value, and the
  // auto-poll's `mode === 'files'` guard would prevent recovery. Each chained
  // step re-evaluates pickSource against the latest settings, so a swap
  // intent that's no longer correct silently no-ops.
  let swapChain: Promise<void> = Promise.resolve();
  const maybeSwapMode = () => {
    if (!tracker) return;
    swapChain = swapChain.then(async () => {
      if (!tracker) return;
      const next = pickSource(context, sessionIdsFn);
      if (next.mode === tracker.mode) {
        // No effective mode change — release the freshly created reader/source
        // without disturbing the running tracker.
        next.source.dispose();
        return;
      }
      const prevMode = tracker.mode;
      try {
        await tracker.swapSource(next.source, next.mode);
        log(`Estimation mode swapped: ${prevMode} → ${next.mode}`);
        if (prevMode === 'files' && next.mode === 'telemetry') {
          const shown = context.workspaceState.get<boolean>(
            MODE_SWAP_SHOWN_KEY,
            false,
          );
          if (!shown) {
            await context.workspaceState.update(MODE_SWAP_SHOWN_KEY, true);
            vscode.window.showInformationMessage(
              'Switched to Telemetry mode — historical totals stay as-is; new activity uses measured tokens.',
            );
          }
        }
      } catch (err) {
        log(`swapSource failed: ${String(err)}`);
      }
    });
  };

  const otelSub = onDidChangeOTelSetting(maybeSwapMode);
  context.subscriptions.push(otelSub);

  // Periodic re-eval to recover from the "DB materializes after activation"
  // case: upstream setting is on, but `agent-traces.db` didn't exist yet at
  // activation (or wasn't visible from this window). Without this poll, the
  // tracker would stay in Files mode for the rest of the session — even
  // after the user used Copilot Chat and the DB appeared — because no config
  // event would fire to trigger the existing swap path.
  //
  // Only check when we'd actually transition Files → Telemetry: if we're
  // already in Telemetry, there's nothing to upgrade; if the upstream
  // setting is off, the asymmetric invariant means we shouldn't auto-swap
  // anyway.
  const modeRefresh = setInterval(() => {
    if (!tracker || tracker.mode === 'telemetry') return;
    if (!isOTelDbExporterEnabled()) return;
    maybeSwapMode();
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(modeRefresh) });
}

export async function deactivate(): Promise<void> {
  if (tracker) {
    // Check for hook truncation before the final write so we don't restore
    // stale cumulative stats over a freshly consumed file. Awaiting here
    // also drains any in-flight check started from a listener or the poll.
    const wasReset = await checkCommitReset().catch(() => false);
    if (!wasReset) {
      await writeTrackingFile(tracker.getStats()).catch(() => {});
    }
    tracker.dispose();
    tracker = null;
  }
  if (statusBar) {
    statusBar.dispose();
    statusBar = null;
  }
  consumeInFlight = null;
  disposeLogger();
}
