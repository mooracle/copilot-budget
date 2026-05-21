import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOOK_SCRIPT } from './commitHook';

describe('hook script (runtime behaviour)', () => {
  let tmpDir: string;
  let hookPath: string;
  let gitDir: string;
  let msgFile: string;
  let trackingFilePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hook-'));
    hookPath = path.join(tmpDir, 'prepare-commit-msg');
    gitDir = path.join(tmpDir, '.git');
    msgFile = path.join(tmpDir, 'COMMIT_EDITMSG');
    trackingFilePath = path.join(gitDir, 'copilot-budget');
    fs.writeFileSync(hookPath, HOOK_SCRIPT);
    fs.chmodSync(hookPath, 0o755);
    // Minimum scaffolding so `git rev-parse --git-dir` (used by the
    // non-squash path) accepts $GIT_DIR and echoes it back. The squash
    // path never calls git, so this is only load-bearing for the
    // non-squash regression tests.
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
  ): { message: string; tracking: string | null } {
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
    return { message, tracking };
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
  });

  describe('non-squash source: tracking-file path', () => {
    it('appends trailers and truncates the tracking file on a normal commit', () => {
      const tracking =
        'SINCE=1\nTOTAL_AI_CREDITS=12.50\nTR_Copilot-AI-Credits=12.50\n';
      const { message, tracking: postTracking } = runHook(
        'subject\n',
        '',
        { trackingFile: tracking },
      );
      expect(message).toContain('Copilot-AI-Credits: 12.50');
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
});
