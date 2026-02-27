import { __configStore, __configChangeListeners } from './__mocks__/vscode';

// Must import after mock is set up (jest resolves vscode → __mocks__/vscode)
import { isEnabled, isCommitHookEnabled, getPlanSetting, getTrailerConfig, onConfigChanged } from './config';

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
      __configStore['copilot-budget.enabled'] = false;
      expect(isEnabled()).toBe(false);
    });
  });

  describe('isCommitHookEnabled', () => {
    it('returns false by default', () => {
      expect(isCommitHookEnabled()).toBe(false);
    });

    it('returns true when overridden', () => {
      __configStore['copilot-budget.commitHook.enabled'] = true;
      expect(isCommitHookEnabled()).toBe(true);
    });
  });

  describe('getPlanSetting', () => {
    it('returns "auto" by default', () => {
      expect(getPlanSetting()).toBe('auto');
    });

    it('returns configured plan value', () => {
      __configStore['copilot-budget.plan'] = 'pro';
      expect(getPlanSetting()).toBe('pro');
    });

    it('returns "pro+" when configured', () => {
      __configStore['copilot-budget.plan'] = 'pro+';
      expect(getPlanSetting()).toBe('pro+');
    });

    it('returns "enterprise" when configured', () => {
      __configStore['copilot-budget.plan'] = 'enterprise';
      expect(getPlanSetting()).toBe('enterprise');
    });
  });

  describe('getTrailerConfig', () => {
    it('returns defaults when no overrides set', () => {
      const config = getTrailerConfig();
      expect(config.premiumRequests).toBe('Copilot-Premium-Requests');
      expect(config.estimatedCost).toBe('Copilot-Est-Cost');
      expect(config.model).toBe(false);
    });

    it('returns custom trailer names', () => {
      __configStore['copilot-budget.commitHook.trailers.premiumRequests'] = 'AI-Requests';
      __configStore['copilot-budget.commitHook.trailers.estimatedCost'] = 'AI-Cost';
      __configStore['copilot-budget.commitHook.trailers.model'] = 'AI-Model';

      const config = getTrailerConfig();
      expect(config.premiumRequests).toBe('AI-Requests');
      expect(config.estimatedCost).toBe('AI-Cost');
      expect(config.model).toBe('AI-Model');
    });

    it('returns false when trailers are disabled', () => {
      __configStore['copilot-budget.commitHook.trailers.premiumRequests'] = false;
      __configStore['copilot-budget.commitHook.trailers.estimatedCost'] = false;

      const config = getTrailerConfig();
      expect(config.premiumRequests).toBe(false);
      expect(config.estimatedCost).toBe(false);
    });
  });

  describe('onConfigChanged', () => {
    it('registers a listener and calls it for copilot-budget changes', () => {
      const callback = jest.fn();
      onConfigChanged(callback);

      expect(__configChangeListeners.length).toBe(1);

      // Simulate a copilot-budget config change
      const event = { affectsConfiguration: (section: string) => section === 'copilot-budget' };
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
