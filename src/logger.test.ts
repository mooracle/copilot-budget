import { window } from 'vscode';
import { log, getOutputChannel, disposeLogger } from './logger';

describe('logger', () => {
  beforeEach(() => {
    // Reset module state between tests by disposing
    disposeLogger();
    (window.createOutputChannel as jest.Mock).mockClear();
  });

  describe('getOutputChannel', () => {
    it('creates an output channel named Copilot Budget', () => {
      const channel = getOutputChannel();
      expect(window.createOutputChannel).toHaveBeenCalledWith('Copilot Budget');
      expect(channel.name).toBe('Copilot Budget');
    });

    it('returns the same channel on subsequent calls (singleton)', () => {
      const first = getOutputChannel();
      const second = getOutputChannel();
      expect(first).toBe(second);
      expect(window.createOutputChannel).toHaveBeenCalledTimes(1);
    });
  });

  describe('log', () => {
    it('appends a timestamped message to the channel', () => {
      log('test message');
      const channel = getOutputChannel();
      expect(channel.appendLine).toHaveBeenCalledWith(
        expect.stringMatching(/^\[.*\] test message$/),
      );
    });

    it('includes ISO timestamp format', () => {
      log('hello');
      const channel = getOutputChannel();
      const call = (channel.appendLine as jest.Mock).mock.calls[0][0];
      // Extract timestamp between brackets
      const match = call.match(/^\[(.+?)\]/);
      expect(match).not.toBeNull();
      // Verify it's a valid ISO date
      const date = new Date(match![1]);
      expect(date.getTime()).not.toBeNaN();
    });
  });

  describe('disposeLogger', () => {
    it('disposes the channel', () => {
      const channel = getOutputChannel();
      disposeLogger();
      expect(channel.dispose).toHaveBeenCalled();
    });

    it('creates a new channel after dispose', () => {
      getOutputChannel();
      disposeLogger();
      getOutputChannel();
      expect(window.createOutputChannel).toHaveBeenCalledTimes(2);
    });

    it('does nothing if no channel exists', () => {
      // Should not throw
      disposeLogger();
    });
  });
});
