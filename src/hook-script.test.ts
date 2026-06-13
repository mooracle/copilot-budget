import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOOK_SCRIPT, POST_COMMIT_SCRIPT } from './commitHook';

describe('hook script (runtime behaviour)', () => {
  let tmpDir: string;
  let hookPath: string;
  let postHookPath: string;
  let gitDir: string;
  let msgFile: string;
  let trackingFilePath: string;
  let pendingPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hook-'));
    hookPath = path.join(tmpDir, 'prepare-commit-msg');
    postHookPath = path.join(tmpDir, 'post-commit');
    gitDir = path.join(tmpDir, '.git');
    msgFile = path.join(tmpDir, 'COMMIT_EDITMSG');
    trackingFilePath = path.join(gitDir, 'copilot-budget');
    pendingPath = path.join(gitDir, 'copilot-budget.pending');
    fs.writeFileSync(hookPath, HOOK_SCRIPT);
    fs.chmodSync(hookPath, 0o755);
    fs.writeFileSync(postHookPath, POST_COMMIT_SCRIPT);
    fs.chmodSync(postHookPath, 0o755);
    // Minimum scaffolding so `git rev-parse --git-dir` accepts $GIT_DIR and
    // echoes it back. Both hooks now resolve $GIT_DIR up front.
    fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runHook(
    msgContent: string,
    source: string,
    opts: { trackingFile?: string } = {},
  ): { message: string; tracking: string | null; pending: boolean } {
    fs.writeFileSync(msgFile, msgContent);
    if (opts.trackingFile !== undefined) {
      fs.writeFileSync(trackingFilePath, opts.trackingFile);
    }
    // GIT_DIR is required: `git rev-parse --git-dir` honours the env value
    // without validating contents, so the non-squash path resolves the
    // tracking file correctly without needing a real `git init`.
    const args = source === '' ? [hookPath, msgFile] : [hookPath, msgFile, source];
    execFileSync('sh', args, {
      env: { ...process.env, GIT_DIR: gitDir },
      stdio: 'pipe',
    });
    const message = fs.readFileSync(msgFile, 'utf8');
    const tracking = fs.existsSync(trackingFilePath)
      ? fs.readFileSync(trackingFilePath, 'utf8')
      : null;
    return { message, tracking, pending: fs.existsSync(pendingPath) };
  }

  // Runs the post-commit hook (the deferred-truncation step). Optionally
  // creates the pending marker first to simulate prepare-commit-msg having run
  // its trailer-append path.
  function runPostCommit(opts: { marker?: boolean } = {}): {
    tracking: string | null;
    pending: boolean;
  } {
    if (opts.marker) fs.writeFileSync(pendingPath, '');
    execFileSync('sh', [postHookPath], {
      env: { ...process.env, GIT_DIR: gitDir },
      stdio: 'pipe',
    });
    const tracking = fs.existsSync(trackingFilePath)
      ? fs.readFileSync(trackingFilePath, 'utf8')
      : null;
    return { tracking, pending: fs.existsSync(pendingPath) };
  }

  describe('squash source: sums duplicate trailers', () => {
    it('sums two identical totals into one trailer at the first occurrence', () => {
      const msg = [
        'first subject',
        '',
        'Copilot-AI-Credits: 10.00',
        '',
        'second subject',
        '',
        'Copilot-AI-Credits: 5.00',
        '',
      ].join('\n');
      const { message } = runHook(msg, 'squash');
      const matches = message.match(/^Copilot-AI-Credits: .*$/gm) ?? [];
      expect(matches).toEqual(['Copilot-AI-Credits: 15.00']);
      // First occurrence position is preserved: line index of the surviving
      // trailer matches the line index of the first input trailer.
      const lines = message.split('\n');
      expect(lines.indexOf('Copilot-AI-Credits: 15.00')).toBe(2);
    });

    it('sums three values: 10.00 + 5.00 + 3.50 = 18.50', () => {
      const msg = [
        'Copilot-AI-Credits: 10.00',
        'Copilot-AI-Credits: 5.00',
        'Copilot-AI-Credits: 3.50',
      ].join('\n');
      const { message } = runHook(msg, 'squash');
      const matches = message.match(/^Copilot-AI-Credits: .*$/gm) ?? [];
      expect(matches).toEqual(['Copilot-AI-Credits: 18.50']);
    });

    it('sums total and per-model trailers separately', () => {
      const msg = [
        'first',
        '',
        'Copilot-AI-Credits: 10.00',
        'Copilot-AI-Credits-Claude-Sonnet-4-6: 8.00',
        '',
        'second',
        '',
        'Copilot-AI-Credits: 10.00',
        'Copilot-AI-Credits-Claude-Sonnet-4-6: 8.00',
      ].join('\n');
      const { message } = runHook(msg, 'squash');
      const totals = message.match(/^Copilot-AI-Credits: .*$/gm) ?? [];
      const perModel = message.match(/^Copilot-AI-Credits-Claude-Sonnet-4-6: .*$/gm) ?? [];
      expect(totals).toEqual(['Copilot-AI-Credits: 20.00']);
      expect(perModel).toEqual(['Copilot-AI-Credits-Claude-Sonnet-4-6: 16.00']);
    });

    it('sums three same-model occurrences into one', () => {
      const msg = [
        'Copilot-AI-Credits-GPT-4o: 4.00',
        'Copilot-AI-Credits-GPT-4o: 4.00',
        'Copilot-AI-Credits-GPT-4o: 4.00',
      ].join('\n');
      const { message } = runHook(msg, 'squash');
      const matches = message.match(/^Copilot-AI-Credits-GPT-4o: .*$/gm) ?? [];
      expect(matches).toEqual(['Copilot-AI-Credits-GPT-4o: 12.00']);
    });

    it('tolerates whitespace variations around the value', () => {
      const msg = [
        'Copilot-AI-Credits:  10.00',
        'Copilot-AI-Credits: 10.00 ',
      ].join('\n');
      const { message } = runHook(msg, 'squash');
      const matches = message.match(/^Copilot-AI-Credits: .*$/gm) ?? [];
      expect(matches).toEqual(['Copilot-AI-Credits: 20.00']);
    });

    it('also sums body lines matching the pattern (accepted trade-off)', () => {
      // Documented limitation: squashed messages do NOT have a clean trailing
      // trailer block (original trailers are scattered between subjects/bodies),
      // so we use free-form line matching. A prose line that literally reads
      // `Copilot-AI-Credits: <number>` will be summed in. Rare and specific.
      const msg = [
        'Subject',
        '',
        'Copilot-AI-Credits: 9999',
        '',
        'second commit',
        '',
        'Copilot-AI-Credits: 1.00',
      ].join('\n');
      const { message } = runHook(msg, 'squash');
      const matches = message.match(/^Copilot-AI-Credits: .*$/gm) ?? [];
      expect(matches).toEqual(['Copilot-AI-Credits: 10000.00']);
    });

    it('leaves messages without Copilot trailers byte-for-byte unchanged', () => {
      const msg = 'subject\n\nbody line one\nbody line two\n';
      const { message } = runHook(msg, 'squash');
      expect(message).toBe(msg);
    });

    it('passes through empty messages', () => {
      const { message } = runHook('', 'squash');
      expect(message).toBe('');
    });

    it('does NOT consult the tracking file or truncate it on squash', () => {
      const initialTracking =
        'SINCE=1\nTOTAL_AI_CREDITS=99.99\nTR_Copilot-AI-Credits=99.99\n';
      const msg = 'subject\n\nCopilot-AI-Credits: 5.00\n';
      const { message, tracking } = runHook(msg, 'squash', {
        trackingFile: initialTracking,
      });
      // No fresh trailer appended from the tracking file (only the existing
      // duplicate gets summed; here there is only one so it stays as-is).
      const matches = message.match(/^Copilot-AI-Credits: .*$/gm) ?? [];
      expect(matches).toEqual(['Copilot-AI-Credits: 5.00']);
      expect(tracking).toBe(initialTracking);
    });

    it('does not match lines with trailing non-numeric text', () => {
      // The regex is anchored `^…$` and the value must be purely numeric,
      // so `Copilot-AI-Credits: 10.00 (estimated)` is left untouched.
      const msg = 'Copilot-AI-Credits: 10.00 (estimated)\n';
      const { message } = runHook(msg, 'squash');
      expect(message).toBe(msg);
    });

    it('sums trailers from a real git merge --squash SQUASH_MSG (4-space indent)', () => {
      // git merge --squash writes SQUASH_MSG using git's standard log format,
      // which indents inherited commit bodies (including their trailers) with
      // four spaces. The leading [ \t]* in the regex matches them. Emitted
      // trailers are unindented so downstream tooling that greps for
      // `^Copilot-AI-Credits:` can find them.
      const msg = [
        'Squashed commit of the following:',
        '',
        'commit b2d09dc7d1951bff23fa50bfd3c0bc21ef82bfb5',
        'Author: t <t@t>',
        'Date:   Fri May 22 00:29:06 2026 +0200',
        '',
        '    feature two',
        '    ',
        '    Copilot-AI-Credits: 3.00',
        '',
        'commit 03bcaf239abf0e269e89ca7963f820835196e5fd',
        'Author: t <t@t>',
        'Date:   Fri May 22 00:29:06 2026 +0200',
        '',
        '    feature one',
        '    ',
        '    Copilot-AI-Credits: 5.00',
        '',
      ].join('\n');
      const { message } = runHook(msg, 'squash');
      const matches = message.match(/^Copilot-AI-Credits: .*$/gm) ?? [];
      expect(matches).toEqual(['Copilot-AI-Credits: 8.00']);
      // The original indented trailer lines are gone — no duplicates left in
      // the body (even with leading whitespace).
      const anyIndentedTrailer = message.match(/^[ \t]+Copilot-AI-Credits:/gm) ?? [];
      expect(anyIndentedTrailer).toEqual([]);
    });
  });

  describe('rebase in progress: sums trailers, leaves tracking file alone', () => {
    // git rebase -i (squash/fixup/reword/edit) invokes prepare-commit-msg with
    // source=message, not source=squash. The hook detects rebase state via
    // $GIT_DIR/rebase-merge (rebase -i / interactive) or $GIT_DIR/rebase-apply
    // (am-style) and routes to the same sum path used by $2 == squash.

    it('sums duplicate trailers when rebase-merge dir exists (rebase -i squash)', () => {
      fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
      const tracking =
        'SINCE=1\nTOTAL_AI_CREDITS=7.00\nTR_Copilot-AI-Credits=7.00\n';
      const msg = [
        'first commit',
        'Copilot-AI-Credits: 10.00',
        '',
        'second commit',
        'Copilot-AI-Credits: 5.00',
        '',
      ].join('\n');
      const { message, tracking: postTracking } = runHook(msg, 'message', {
        trackingFile: tracking,
      });
      const matches = message.match(/^Copilot-AI-Credits: .*$/gm) ?? [];
      expect(matches).toEqual(['Copilot-AI-Credits: 15.00']);
      // Tracking file must survive the rebase unchanged — its tally belongs
      // to the NEXT real commit, not the transient rebase step.
      expect(postTracking).toBe(tracking);
    });

    it('sums duplicate trailers when rebase-apply dir exists (am-style rebase)', () => {
      fs.mkdirSync(path.join(gitDir, 'rebase-apply'));
      const msg = 'Copilot-AI-Credits: 4.00\nCopilot-AI-Credits: 6.00\n';
      const { message } = runHook(msg, 'message');
      const matches = message.match(/^Copilot-AI-Credits: .*$/gm) ?? [];
      expect(matches).toEqual(['Copilot-AI-Credits: 10.00']);
    });

    it('does not append a fresh trailer from the tracking file during rebase', () => {
      fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
      const tracking =
        'SINCE=1\nTOTAL_AI_CREDITS=12.50\nTR_Copilot-AI-Credits=12.50\n';
      const msg = 'subject\n\nbody\n';
      const { message, tracking: postTracking } = runHook(msg, 'message', {
        trackingFile: tracking,
      });
      // No tracking-file trailer appended; no truncation.
      expect(message).toBe(msg);
      expect(postTracking).toBe(tracking);
    });
  });

  describe('non-squash source: tracking-file path', () => {
    it('appends trailers and writes the pending marker WITHOUT truncating (deferred to post-commit)', () => {
      const tracking =
        'SINCE=1\nTOTAL_AI_CREDITS=12.50\nTR_Copilot-AI-Credits=12.50\n';
      const { message, tracking: postTracking, pending } = runHook(
        'subject\n',
        '',
        { trackingFile: tracking },
      );
      expect(message).toContain('Copilot-AI-Credits: 12.50');
      // Tracking file is left intact — issue #10: a cancelled commit must not
      // reset the counter. The marker signals post-commit to truncate later.
      expect(postTracking).toBe(tracking);
      expect(pending).toBe(true);
    });

    it('post-commit truncates the tracking file once the commit lands', () => {
      const tracking =
        'SINCE=1\nTOTAL_AI_CREDITS=12.50\nTR_Copilot-AI-Credits=12.50\n';
      runHook('subject\n', '', { trackingFile: tracking });
      // prepare-commit-msg left the marker; the real commit now runs post-commit.
      const { tracking: postTracking, pending } = runPostCommit();
      expect(postTracking).toBe('');
      expect(pending).toBe(false);
    });

    it('a cancelled commit (no post-commit) leaves the counter intact', () => {
      const tracking =
        'SINCE=1\nTOTAL_AI_CREDITS=12.50\nTR_Copilot-AI-Credits=12.50\n';
      // First attempt: prepare runs, user cancels — post-commit never fires.
      const first = runHook('subject\n', '', { trackingFile: tracking });
      expect(first.tracking).toBe(tracking);
      expect(first.pending).toBe(true);
      // Second attempt against the same intact tracking file behaves identically.
      const second = runHook('subject\n', '', { trackingFile: tracking });
      expect(second.message).toContain('Copilot-AI-Credits: 12.50');
      expect(second.tracking).toBe(tracking);
      expect(second.pending).toBe(true);
      // Only when a commit actually lands does post-commit reset it.
      const { tracking: postTracking } = runPostCommit();
      expect(postTracking).toBe('');
    });

    it('exits cleanly on $2 == commit (amend) without touching the message or tracking file', () => {
      const tracking =
        'SINCE=1\nTOTAL_AI_CREDITS=12.50\nTR_Copilot-AI-Credits=12.50\n';
      const msg = 'subject\n\nbody\n';
      const { message, tracking: postTracking } = runHook(msg, 'commit', {
        trackingFile: tracking,
      });
      expect(message).toBe(msg);
      expect(postTracking).toBe(tracking);
    });

    it('exits cleanly on $2 == merge without touching the message or tracking file', () => {
      const tracking =
        'SINCE=1\nTOTAL_AI_CREDITS=12.50\nTR_Copilot-AI-Credits=12.50\n';
      const msg = 'merge subject\n\nbody\n';
      const { message, tracking: postTracking } = runHook(msg, 'merge', {
        trackingFile: tracking,
      });
      expect(message).toBe(msg);
      expect(postTracking).toBe(tracking);
    });

    it('leaves the message unchanged when no tracking file is present', () => {
      const msg = 'subject\n';
      const { message, tracking } = runHook(msg, '');
      expect(message).toBe(msg);
      expect(tracking).toBe(null);
    });
  });

  describe('stale pending marker is cleared on non-trailer paths', () => {
    // A normal-commit attempt left a marker; the user cancelled, then did a
    // merge/commit/squash/rebase instead. Those paths must clear the stale
    // marker so the following post-commit doesn't truncate usage that the new
    // commit never carried as a trailer.
    const tracking =
      'SINCE=1\nTOTAL_AI_CREDITS=9.99\nTR_Copilot-AI-Credits=9.99\n';

    function seedMarker(): void {
      fs.writeFileSync(trackingFilePath, tracking);
      fs.writeFileSync(pendingPath, '');
    }

    it('clears the marker on $2 == merge', () => {
      seedMarker();
      const { pending, tracking: postTracking } = runHook('m\n', 'merge');
      expect(pending).toBe(false);
      expect(postTracking).toBe(tracking);
    });

    it('clears the marker on $2 == commit (amend)', () => {
      seedMarker();
      const { pending } = runHook('m\n', 'commit');
      expect(pending).toBe(false);
    });

    it('clears the marker on $2 == squash', () => {
      seedMarker();
      const { pending } = runHook('m\n', 'squash');
      expect(pending).toBe(false);
    });

    it('clears the marker during a rebase', () => {
      fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
      seedMarker();
      const { pending } = runHook('m\n', 'message');
      expect(pending).toBe(false);
    });
  });

  describe('post-commit hook (deferred truncation)', () => {
    const tracking =
      'SINCE=1\nTOTAL_AI_CREDITS=12.50\nTR_Copilot-AI-Credits=12.50\n';

    it('truncates the tracking file and removes the marker when the marker is present', () => {
      fs.writeFileSync(trackingFilePath, tracking);
      const { tracking: postTracking, pending } = runPostCommit({ marker: true });
      expect(postTracking).toBe('');
      expect(pending).toBe(false);
    });

    it('leaves the tracking file untouched when there is no marker', () => {
      fs.writeFileSync(trackingFilePath, tracking);
      const { tracking: postTracking } = runPostCommit();
      expect(postTracking).toBe(tracking);
    });

    it('does NOT truncate during a rebase even if a marker is present', () => {
      // Plain `pick` rebase steps fire post-commit but not prepare-commit-msg,
      // so a stale marker could survive into the rebase. The rebase guard must
      // prevent truncation of usage destined for the next real commit.
      fs.mkdirSync(path.join(gitDir, 'rebase-merge'));
      fs.writeFileSync(trackingFilePath, tracking);
      const { tracking: postTracking, pending } = runPostCommit({ marker: true });
      expect(postTracking).toBe(tracking);
      // Marker is preserved (not consumed) so the next real commit can use it.
      expect(pending).toBe(true);
    });

    it('does NOT truncate during an am-style rebase (rebase-apply)', () => {
      fs.mkdirSync(path.join(gitDir, 'rebase-apply'));
      fs.writeFileSync(trackingFilePath, tracking);
      const { tracking: postTracking, pending } = runPostCommit({ marker: true });
      expect(postTracking).toBe(tracking);
      expect(pending).toBe(true);
    });
  });
});
