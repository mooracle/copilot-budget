import { __configStore, __configChangeListeners } from './__mocks__/vscode';

// Must import after mock is set up (jest resolves vscode → __mocks__/vscode)
import { isEnabled, isCommitHookEnabled, getCommitHookFormat, onConfigChanged } from './config';

beforeEach(() => {
  // Clear overrides between tests
  for (const key of Object.keys(__configStore)) delete __configStore[key];
  __configChangeListeners.length = 0;
});

describe('config', () => {
  describe('isEnabled', () => {
    it('returns true by default', () => {
      expect(isEnabled()).toBe(true);
    });

    it('returns false when overridden', () => {
      __configStore['tokentrack.enabled'] = false;
      expect(isEnabled()).toBe(false);
    });
  });

  describe('isCommitHookEnabled', () => {
    it('returns false by default', () => {
      expect(isCommitHookEnabled()).toBe(false);
    });

    it('returns true when overridden', () => {
      __configStore['tokentrack.commitHook.enabled'] = true;
      expect(isCommitHookEnabled()).toBe(true);
    });
  });

  describe('getCommitHookFormat', () => {
    it('returns default format string', () => {
      expect(getCommitHookFormat()).toBe('AI Budget: {models} | total: {total} tokens');
    });

    it('returns custom format when overridden', () => {
      __configStore['tokentrack.commitHook.format'] = 'Tokens: {total}';
      expect(getCommitHookFormat()).toBe('Tokens: {total}');
    });
  });

  describe('onConfigChanged', () => {
    it('registers a listener and calls it for tokentrack changes', () => {
      const callback = jest.fn();
      onConfigChanged(callback);

      expect(__configChangeListeners.length).toBe(1);

      // Simulate a tokentrack config change
      const event = { affectsConfiguration: (section: string) => section === 'tokentrack' };
      __configChangeListeners[0](event);

      expect(callback).toHaveBeenCalledWith(event);
    });

    it('does not call listener for unrelated config changes', () => {
      const callback = jest.fn();
      onConfigChanged(callback);

      const event = { affectsConfiguration: (section: string) => section === 'editor' };
      __configChangeListeners[0](event);

      expect(callback).not.toHaveBeenCalled();
    });

    it('returns a disposable that removes the listener', () => {
      const callback = jest.fn();
      const disposable = onConfigChanged(callback);

      expect(__configChangeListeners.length).toBe(1);
      disposable.dispose();
      expect(__configChangeListeners.length).toBe(0);
    });
  });
});
