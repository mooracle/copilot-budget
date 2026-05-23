import {
  __configStore,
  __configChangeListeners,
  __inspectStore,
  __workspaceUpdate,
} from './__mocks__/vscode';

// Must import after mock is set up (jest resolves vscode → __mocks__/vscode)
import {
  isEnabled,
  isCommitHookEnabled,
  getTrailerConfig,
  onConfigChanged,
  getDisplayCurrency,
  isOTelDbExporterEnabled,
  autoEnableOTel,
} from './config';

beforeEach(() => {
  // Clear overrides between tests
  for (const key of Object.keys(__configStore)) delete __configStore[key];
  for (const key of Object.keys(__inspectStore)) delete __inspectStore[key];
  __configChangeListeners.length = 0;
  __workspaceUpdate.mockClear();
  __workspaceUpdate.mockImplementation(async () => {});
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
    it('returns false by default (opt-in)', () => {
      expect(isCommitHookEnabled()).toBe(false);
    });

    it('returns true when overridden', () => {
      __configStore['copilot-budget.commitHook.enabled'] = true;
      expect(isCommitHookEnabled()).toBe(true);
    });
  });

  describe('getTrailerConfig', () => {
    it('returns defaults when no overrides set', () => {
      const config = getTrailerConfig();
      // estimatedCost is opt-in: AI Credits is the primary trailer.
      expect(config.estimatedCost).toBe(false);
      expect(config.aiCredits).toBe('Copilot-AI-Credits');
      expect(config.aiCreditsPerModel).toBe(false);
    });

    it('returns the configured trailer key when estimatedCost is explicitly enabled', () => {
      __configStore['copilot-budget.commitHook.trailers.estimatedCost'] = 'Copilot-Est-Cost';
      const config = getTrailerConfig();
      expect(config.estimatedCost).toBe('Copilot-Est-Cost');
    });

    it('returns custom trailer names', () => {
      __configStore['copilot-budget.commitHook.trailers.estimatedCost'] = 'AI-Cost';
      __configStore['copilot-budget.commitHook.trailers.aiCredits'] = 'AI-Credits';
      __configStore['copilot-budget.commitHook.trailers.aiCreditsPerModel'] = 'AI-Credits-Models';

      const config = getTrailerConfig();
      expect(config.estimatedCost).toBe('AI-Cost');
      expect(config.aiCredits).toBe('AI-Credits');
      expect(config.aiCreditsPerModel).toBe('AI-Credits-Models');
    });

    it('returns false when trailers are disabled', () => {
      __configStore['copilot-budget.commitHook.trailers.estimatedCost'] = false;
      __configStore['copilot-budget.commitHook.trailers.aiCredits'] = false;

      const config = getTrailerConfig();
      expect(config.estimatedCost).toBe(false);
      expect(config.aiCredits).toBe(false);
    });

    it('treats boolean true as the default value (string for aiCredits, false for opt-in trailers)', () => {
      __configStore['copilot-budget.commitHook.trailers.estimatedCost'] = true;
      __configStore['copilot-budget.commitHook.trailers.aiCredits'] = true;
      __configStore['copilot-budget.commitHook.trailers.aiCreditsPerModel'] = true;

      const config = getTrailerConfig();
      // estimatedCost default is false (opt-in), so boolean-true falls back to false
      expect(config.estimatedCost).toBe(false);
      expect(config.aiCredits).toBe('Copilot-AI-Credits');
      // aiCreditsPerModel default is false, so boolean-true falls back to false
      expect(config.aiCreditsPerModel).toBe(false);
    });

    it('strips newlines, equals, slashes, and backslashes from trailer keys', () => {
      __configStore['copilot-budget.commitHook.trailers.estimatedCost'] = 'Trailer\nInjection=bad';
      const config = getTrailerConfig();
      expect(config.estimatedCost).toBe('TrailerInjectionbad');

      __configStore['copilot-budget.commitHook.trailers.estimatedCost'] = 'Copilot/Cost\\Value';
      const config2 = getTrailerConfig();
      expect(config2.estimatedCost).toBe('CopilotCostValue');
    });

    it('returns false for empty string trailer key', () => {
      __configStore['copilot-budget.commitHook.trailers.aiCredits'] = '';

      const config = getTrailerConfig();
      expect(config.aiCredits).toBe(false);
    });
  });

  describe('getDisplayCurrency', () => {
    it('returns "aic" by default', () => {
      expect(getDisplayCurrency()).toBe('aic');
    });

    it('returns "usd" when set to usd', () => {
      __configStore['copilot-budget.displayCurrency'] = 'usd';
      expect(getDisplayCurrency()).toBe('usd');
    });

    it('returns "aic" when set to aic explicitly', () => {
      __configStore['copilot-budget.displayCurrency'] = 'aic';
      expect(getDisplayCurrency()).toBe('aic');
    });

    it('falls back to "aic" for unknown values', () => {
      __configStore['copilot-budget.displayCurrency'] = 'eur';
      expect(getDisplayCurrency()).toBe('aic');
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

  describe('isOTelDbExporterEnabled', () => {
    it('returns false by default (upstream setting is opt-in)', () => {
      expect(isOTelDbExporterEnabled()).toBe(false);
    });

    it('returns true when the upstream setting is enabled', () => {
      __configStore['github.copilot.chat.otel.dbSpanExporter.enabled'] = true;
      expect(isOTelDbExporterEnabled()).toBe(true);
    });
  });

  describe('autoEnableOTel', () => {
    const OTEL_FULL = 'github.copilot.chat.otel.dbSpanExporter.enabled';

    it('writes true at Workspace scope when setting is undefined everywhere', async () => {
      // inspect returns undefined globalValue/workspaceValue (default empty entry)
      __inspectStore[OTEL_FULL] = {
        key: OTEL_FULL,
        defaultValue: false,
        globalValue: undefined,
        workspaceValue: undefined,
      };
      await autoEnableOTel();
      expect(__workspaceUpdate).toHaveBeenCalledTimes(1);
      expect(__workspaceUpdate).toHaveBeenCalledWith(
        'github.copilot.chat.otel',
        'dbSpanExporter.enabled',
        true,
        2, // ConfigurationTarget.Workspace
      );
    });

    it('writes true when inspect() itself returns undefined (no scope info at all)', async () => {
      // Default mock returns undefined for inspect — should still write
      await autoEnableOTel();
      expect(__workspaceUpdate).toHaveBeenCalledTimes(1);
      expect(__workspaceUpdate).toHaveBeenCalledWith(
        'github.copilot.chat.otel',
        'dbSpanExporter.enabled',
        true,
        2,
      );
    });

    it('is a no-op when explicitly set to false at Workspace scope', async () => {
      __inspectStore[OTEL_FULL] = {
        key: OTEL_FULL,
        defaultValue: false,
        globalValue: undefined,
        workspaceValue: false,
      };
      await autoEnableOTel();
      expect(__workspaceUpdate).not.toHaveBeenCalled();
    });

    it('is a no-op when explicitly set to false at Global scope', async () => {
      __inspectStore[OTEL_FULL] = {
        key: OTEL_FULL,
        defaultValue: false,
        globalValue: false,
        workspaceValue: undefined,
      };
      await autoEnableOTel();
      expect(__workspaceUpdate).not.toHaveBeenCalled();
    });

    it('is a no-op when already true at Workspace scope', async () => {
      __inspectStore[OTEL_FULL] = {
        key: OTEL_FULL,
        defaultValue: false,
        globalValue: undefined,
        workspaceValue: true,
      };
      await autoEnableOTel();
      expect(__workspaceUpdate).not.toHaveBeenCalled();
    });

    it('is a no-op when already true at Global scope', async () => {
      __inspectStore[OTEL_FULL] = {
        key: OTEL_FULL,
        defaultValue: false,
        globalValue: true,
        workspaceValue: undefined,
      };
      await autoEnableOTel();
      expect(__workspaceUpdate).not.toHaveBeenCalled();
    });

    it('logs and does not throw when update() rejects', async () => {
      __workspaceUpdate.mockImplementationOnce(async () => {
        throw new Error('boom');
      });
      __inspectStore[OTEL_FULL] = {
        key: OTEL_FULL,
        defaultValue: false,
        globalValue: undefined,
        workspaceValue: undefined,
      };
      await expect(autoEnableOTel()).resolves.toBeUndefined();
      expect(__workspaceUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
