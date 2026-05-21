import { __configStore, __configChangeListeners } from './__mocks__/vscode';

// Must import after mock is set up (jest resolves vscode → __mocks__/vscode)
import {
  isEnabled,
  isCommitHookEnabled,
  getTrailerConfig,
  onConfigChanged,
  getDisplayCurrency,
  isOTelDbExporterEnabled,
  getEstimationMode,
  onDidChangeOTelSetting,
} from './config';

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

  describe('getEstimationMode', () => {
    it('returns "files" when otelReader is null', () => {
      expect(getEstimationMode(null, true)).toBe('files');
    });

    it('returns "files" when upstream setting is disabled, even if DB exists', () => {
      const reader = { isAvailable: () => true };
      expect(getEstimationMode(reader, false)).toBe('files');
    });

    it('returns "files" when upstream is enabled but DB is unavailable (remote-host mismatch)', () => {
      const reader = { isAvailable: () => false };
      expect(getEstimationMode(reader, true)).toBe('files');
    });

    it('returns "telemetry" only when upstream enabled AND DB available', () => {
      const reader = { isAvailable: () => true };
      expect(getEstimationMode(reader, true)).toBe('telemetry');
    });

    it('defaults upstreamEnabled to the current setting when omitted', () => {
      const reader = { isAvailable: () => true };
      // Setting off → mode is files
      expect(getEstimationMode(reader)).toBe('files');
      // Setting on → mode is telemetry
      __configStore['github.copilot.chat.otel.dbSpanExporter.enabled'] = true;
      expect(getEstimationMode(reader)).toBe('telemetry');
    });
  });

  describe('onDidChangeOTelSetting', () => {
    it('fires the callback when the upstream key changes', () => {
      const callback = jest.fn();
      onDidChangeOTelSetting(callback);
      expect(__configChangeListeners.length).toBe(1);

      const event = {
        affectsConfiguration: (section: string) =>
          section === 'github.copilot.chat.otel.dbSpanExporter.enabled',
      };
      __configChangeListeners[0](event);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('does not fire for unrelated config changes', () => {
      const callback = jest.fn();
      onDidChangeOTelSetting(callback);
      const event = {
        affectsConfiguration: (section: string) => section === 'copilot-budget',
      };
      __configChangeListeners[0](event);
      expect(callback).not.toHaveBeenCalled();
    });

    it('returns a disposable that removes the listener', () => {
      const disposable = onDidChangeOTelSetting(() => {});
      expect(__configChangeListeners.length).toBe(1);
      disposable.dispose();
      expect(__configChangeListeners.length).toBe(0);
    });
  });
});
