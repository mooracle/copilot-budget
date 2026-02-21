import { activate, deactivate } from './extension';

describe('extension', () => {
  it('should export activate function', () => {
    expect(typeof activate).toBe('function');
  });

  it('should export deactivate function', () => {
    expect(typeof deactivate).toBe('function');
  });

  it('activate should not throw with mock context', () => {
    const mockContext = {
      subscriptions: [],
      extensionPath: '/test',
      globalState: { get: () => undefined, update: async () => {} },
      workspaceState: { get: () => undefined, update: async () => {} },
      extensionUri: { fsPath: '/test' },
    } as any;

    expect(() => activate(mockContext)).not.toThrow();
  });

  it('deactivate should not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
