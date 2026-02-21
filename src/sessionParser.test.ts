import { parseSessionFileContent, ModelUsage } from './sessionParser';

// Simple estimator: 1 token per 4 characters (ratio 0.25), ceil
const mockEstimate = (text: string, _model?: string): number => Math.ceil(text.length * 0.25);

describe('sessionParser', () => {
  describe('parseSessionFileContent - JSON format', () => {
    it('returns zero stats for empty JSON', () => {
      const result = parseSessionFileContent('session.json', '{}', mockEstimate);
      expect(result).toEqual({
        tokens: 0,
        interactions: 0,
        modelUsage: {},
        thinkingTokens: 0,
      });
    });

    it('returns zero stats for invalid JSON', () => {
      const result = parseSessionFileContent('session.json', 'not json', mockEstimate);
      expect(result).toEqual({
        tokens: 0,
        interactions: 0,
        modelUsage: {},
        thinkingTokens: 0,
      });
    });

    it('parses session with requests using message.text', () => {
      const session = {
        requests: [
          {
            model: 'gpt-4o',
            message: { text: 'Hello world!' }, // 12 chars -> 3 tokens
            response: [{ value: 'Hi there!' }], // 9 chars -> 3 tokens
          },
        ],
      };
      const result = parseSessionFileContent('session.json', JSON.stringify(session), mockEstimate);
      expect(result.interactions).toBe(1);
      expect(result.tokens).toBe(6); // 3 input + 3 output
      expect(result.modelUsage['gpt-4o']).toEqual({ inputTokens: 3, outputTokens: 3 });
      expect(result.thinkingTokens).toBe(0);
    });

    it('parses session with requests using message.parts', () => {
      const session = {
        requests: [
          {
            model: 'claude-sonnet-4',
            message: { parts: [{ text: 'Part one' }, { text: 'Part two' }] }, // 8+8=16 chars -> 4 tokens
            response: [{ value: 'Response text here' }], // 18 chars -> 5 tokens
          },
        ],
      };
      const result = parseSessionFileContent('session.json', JSON.stringify(session), mockEstimate);
      expect(result.interactions).toBe(1);
      expect(result.tokens).toBe(9);
      expect(result.modelUsage['claude-sonnet-4']).toEqual({ inputTokens: 4, outputTokens: 5 });
    });

    it('parses session with history array (alternative format)', () => {
      const session = {
        history: [
          {
            model: 'gpt-4o',
            message: { text: 'test' }, // 4 chars -> 1 token
            response: [{ value: 'ok!!' }], // 4 chars -> 1 token
          },
        ],
      };
      const result = parseSessionFileContent('session.json', JSON.stringify(session), mockEstimate);
      expect(result.interactions).toBe(1);
      expect(result.tokens).toBe(2);
    });

    it('handles multiple models in one session', () => {
      const session = {
        requests: [
          {
            model: 'gpt-4o',
            message: { text: 'aaaa' }, // 4 -> 1
            response: [{ value: 'bbbb' }], // 4 -> 1
          },
          {
            model: 'claude-sonnet-4',
            message: { text: 'cccc' }, // 4 -> 1
            response: [{ value: 'dddd' }], // 4 -> 1
          },
        ],
      };
      const result = parseSessionFileContent('session.json', JSON.stringify(session), mockEstimate);
      expect(result.interactions).toBe(2);
      expect(result.tokens).toBe(4);
      expect(Object.keys(result.modelUsage)).toHaveLength(2);
      expect(result.modelUsage['gpt-4o']).toEqual({ inputTokens: 1, outputTokens: 1 });
      expect(result.modelUsage['claude-sonnet-4']).toEqual({ inputTokens: 1, outputTokens: 1 });
    });

    it('defaults to gpt-4o when model is missing', () => {
      const session = {
        requests: [
          {
            message: { text: 'test' },
            response: [{ value: 'resp' }],
          },
        ],
      };
      const result = parseSessionFileContent('session.json', JSON.stringify(session), mockEstimate);
      expect(result.modelUsage['gpt-4o']).toBeDefined();
    });

    it('separates thinking tokens from output', () => {
      const session = {
        requests: [
          {
            model: 'claude-sonnet-4',
            message: { text: 'test' }, // 4 -> 1
            response: [
              { kind: 'thinking', value: 'internal reasoning here!!' }, // 25 -> 7
              { value: 'visible answer' }, // 14 -> 4
            ],
          },
        ],
      };
      const result = parseSessionFileContent('session.json', JSON.stringify(session), mockEstimate);
      expect(result.thinkingTokens).toBe(7);
      expect(result.modelUsage['claude-sonnet-4'].outputTokens).toBe(4); // thinking not in model output
      expect(result.tokens).toBe(1 + 4 + 7); // input + output + thinking
    });

    it('handles response with message.parts', () => {
      const session = {
        requests: [
          {
            model: 'gpt-4o',
            message: { text: 'test' },
            response: [{ message: { parts: [{ text: 'part response' }] } }], // 13 -> 4
          },
        ],
      };
      const result = parseSessionFileContent('session.json', JSON.stringify(session), mockEstimate);
      expect(result.modelUsage['gpt-4o'].outputTokens).toBe(4);
    });

    it('uses getModelFromRequest callback when provided', () => {
      const session = {
        requests: [
          {
            message: { text: 'test' },
            response: [{ value: 'resp' }],
          },
        ],
      };
      const getModel = () => 'custom-model';
      const result = parseSessionFileContent('session.json', JSON.stringify(session), mockEstimate, getModel);
      expect(result.modelUsage['custom-model']).toBeDefined();
    });

    it('strips copilot/ prefix from model names', () => {
      const session = {
        requests: [
          {
            model: 'copilot/gpt-4o',
            message: { text: 'test' },
            response: [],
          },
        ],
      };
      const result = parseSessionFileContent('session.json', JSON.stringify(session), mockEstimate);
      expect(result.modelUsage['gpt-4o']).toBeDefined();
      expect(result.modelUsage['copilot/gpt-4o']).toBeUndefined();
    });
  });

  describe('parseSessionFileContent - JSONL delta format', () => {
    it('reconstructs session from delta-based JSONL', () => {
      // kind 0 = initial state, kind 1 = update, kind 2 = append
      const lines = [
        JSON.stringify({ kind: 0, v: { requests: [] } }),
        JSON.stringify({ kind: 2, k: ['requests'], v: {
          modelId: 'gpt-4o',
          message: { text: 'hello world!' }, // 12 -> 3
          response: [{ value: 'hi back!!!' }], // 10 -> 3
        }}),
      ];
      const content = lines.join('\n');
      const result = parseSessionFileContent('session.jsonl', content, mockEstimate);
      expect(result.interactions).toBe(1);
      expect(result.tokens).toBe(6);
      expect(result.modelUsage['gpt-4o']).toEqual({ inputTokens: 3, outputTokens: 3 });
    });

    it('handles multiple delta appends', () => {
      const lines = [
        JSON.stringify({ kind: 0, v: { requests: [] } }),
        JSON.stringify({ kind: 2, k: ['requests'], v: {
          modelId: 'gpt-4o',
          message: { text: 'aaaa' },
          response: [{ value: 'bbbb' }],
        }}),
        JSON.stringify({ kind: 2, k: ['requests'], v: {
          modelId: 'claude-sonnet-4',
          message: { text: 'cccc' },
          response: [{ value: 'dddd' }],
        }}),
      ];
      const result = parseSessionFileContent('session.jsonl', lines.join('\n'), mockEstimate);
      expect(result.interactions).toBe(2);
      expect(Object.keys(result.modelUsage)).toHaveLength(2);
    });

    it('handles delta kind 1 (update at path)', () => {
      const lines = [
        JSON.stringify({ kind: 0, v: { requests: [{ modelId: 'gpt-4o', message: { text: 'old' }, response: [] }] } }),
        // Update the response of the first request
        JSON.stringify({ kind: 1, k: ['requests', '0', 'response'], v: [{ value: 'new response!' }] }),
      ];
      const result = parseSessionFileContent('session.jsonl', lines.join('\n'), mockEstimate);
      expect(result.interactions).toBe(1);
      // Output: "new response!" = 13 chars -> 4 tokens
      expect(result.modelUsage['gpt-4o'].outputTokens).toBe(4);
    });

    it('handles thinking tokens in delta format', () => {
      const lines = [
        JSON.stringify({ kind: 0, v: { requests: [] } }),
        JSON.stringify({ kind: 2, k: ['requests'], v: {
          modelId: 'claude-sonnet-4',
          message: { text: 'test' },
          response: [
            { kind: 'thinking', value: 'reasoning!!' }, // 11 -> 3
            { value: 'answer' }, // 6 -> 2
          ],
        }}),
      ];
      const result = parseSessionFileContent('session.jsonl', lines.join('\n'), mockEstimate);
      expect(result.thinkingTokens).toBe(3);
      expect(result.modelUsage['claude-sonnet-4'].outputTokens).toBe(2);
    });

    it('falls back to JSON parse for non-delta JSONL', () => {
      // A .jsonl file that contains a plain JSON object (not delta format)
      const session = {
        requests: [
          {
            model: 'gpt-4o',
            message: { text: 'test' },
            response: [{ value: 'resp' }],
          },
        ],
      };
      const result = parseSessionFileContent('session.jsonl', JSON.stringify(session), mockEstimate);
      expect(result.interactions).toBe(1);
      expect(result.tokens).toBeGreaterThan(0);
    });

    it('returns zero for unparseable JSONL', () => {
      const result = parseSessionFileContent('session.jsonl', 'garbage data\nnot json', mockEstimate);
      expect(result).toEqual({ tokens: 0, interactions: 0, modelUsage: {}, thinkingTokens: 0 });
    });
  });

  describe('parseSessionFileContent - return shape', () => {
    it('returns the expected shape { tokens, interactions, modelUsage, thinkingTokens }', () => {
      const result = parseSessionFileContent('session.json', '{}', mockEstimate);
      expect(result).toHaveProperty('tokens');
      expect(result).toHaveProperty('interactions');
      expect(result).toHaveProperty('modelUsage');
      expect(result).toHaveProperty('thinkingTokens');
      expect(typeof result.tokens).toBe('number');
      expect(typeof result.interactions).toBe('number');
      expect(typeof result.modelUsage).toBe('object');
      expect(typeof result.thinkingTokens).toBe('number');
    });
  });

  describe('prototype pollution prevention', () => {
    it('rejects __proto__ in delta key paths', () => {
      const lines = [
        JSON.stringify({ kind: 0, v: {} }),
        JSON.stringify({ kind: 1, k: ['__proto__', 'polluted'], v: true }),
      ];
      const result = parseSessionFileContent('session.jsonl', lines.join('\n'), mockEstimate);
      // Should not pollute Object.prototype
      expect(({} as any).polluted).toBeUndefined();
      expect(result.tokens).toBe(0);
    });

    it('rejects constructor in delta key paths', () => {
      const lines = [
        JSON.stringify({ kind: 0, v: {} }),
        JSON.stringify({ kind: 1, k: ['constructor', 'prototype'], v: { evil: true } }),
      ];
      parseSessionFileContent('session.jsonl', lines.join('\n'), mockEstimate);
      expect(({} as any).evil).toBeUndefined();
    });

    it('rejects prototype in delta key paths', () => {
      const lines = [
        JSON.stringify({ kind: 0, v: {} }),
        JSON.stringify({ kind: 1, k: ['prototype', 'injected'], v: 'bad' }),
      ];
      parseSessionFileContent('session.jsonl', lines.join('\n'), mockEstimate);
      expect(({} as any).injected).toBeUndefined();
    });

    it('rejects keys starting with double underscore', () => {
      const lines = [
        JSON.stringify({ kind: 0, v: {} }),
        JSON.stringify({ kind: 1, k: ['__custom', 'data'], v: 'bad' }),
      ];
      const result = parseSessionFileContent('session.jsonl', lines.join('\n'), mockEstimate);
      expect(result.tokens).toBe(0);
    });
  });

  describe('response extraction with content.value', () => {
    it('prefers content.value over value in delta response items', () => {
      const lines = [
        JSON.stringify({ kind: 0, v: { requests: [] } }),
        JSON.stringify({ kind: 2, k: ['requests'], v: {
          modelId: 'gpt-4o',
          message: { text: 'test' },
          response: [
            { value: 'wrapper', content: { value: 'actual content!!' } }, // 16 chars -> 4 tokens
          ],
        }}),
      ];
      const result = parseSessionFileContent('session.jsonl', lines.join('\n'), mockEstimate);
      // Should use "actual content!!" (16 chars -> 4) not "wrapper" (7 chars -> 2)
      expect(result.modelUsage['gpt-4o'].outputTokens).toBe(4);
    });
  });

  describe('model normalization', () => {
    it('uses selectedModel.identifier from delta format', () => {
      const lines = [
        JSON.stringify({ kind: 0, v: { requests: [] } }),
        JSON.stringify({ kind: 2, k: ['requests'], v: {
          selectedModel: { identifier: 'claude-opus-4' },
          message: { text: 'test' },
          response: [{ value: 'resp' }],
        }}),
      ];
      const result = parseSessionFileContent('session.jsonl', lines.join('\n'), mockEstimate);
      expect(result.modelUsage['claude-opus-4']).toBeDefined();
    });

    it('strips copilot/ prefix from modelId in delta format', () => {
      const lines = [
        JSON.stringify({ kind: 0, v: { requests: [] } }),
        JSON.stringify({ kind: 2, k: ['requests'], v: {
          modelId: 'copilot/gpt-4o',
          message: { text: 'test' },
          response: [],
        }}),
      ];
      const result = parseSessionFileContent('session.jsonl', lines.join('\n'), mockEstimate);
      expect(result.modelUsage['gpt-4o']).toBeDefined();
    });
  });
});
