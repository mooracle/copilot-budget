import { normalizeModelId as canonicalizeRateName } from './tokenRates';

export interface ModelTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ModelUsage {
  [model: string]: ModelTokens;
}

export interface ParsedSession {
  interactions: number;
  modelUsage: ModelUsage;
  modelInteractions: { [model: string]: number };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafePathSegment(seg: string): boolean {
  // Prevent prototype pollution and other surprising behavior.
  if (typeof seg !== 'string') {
    return false;
  }
  const forbidden = ['__proto__', 'prototype', 'constructor', 'hasOwnProperty'];
  return !forbidden.includes(seg) && !seg.startsWith('__');
}

function isArrayIndexSegment(seg: string): boolean {
  return /^\d+$/.test(seg);
}

const KNOWN_PREFIXES = ['copilot/', 'copilotcli/', 'claude-code/'];

function stripModelPrefix(id: string): string {
  for (const prefix of KNOWN_PREFIXES) {
    if (id.startsWith(prefix)) {
      return id.slice(prefix.length);
    }
  }
  return id;
}

const DEFAULT_MODEL = 'unknown';

function normalizeModelFromRequest(model: unknown): string {
  if (typeof model !== 'string') {
    return DEFAULT_MODEL;
  }
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_MODEL;
  }
  return canonicalizeRateName(stripModelPrefix(trimmed));
}

function clampNonNegInt(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.floor(n);
}

/**
 * Apply a delta to reconstruct session state from delta-based JSONL.
 * VS Code Insiders uses this format where:
 * - kind: 0 = initial state (full replacement)
 * - kind: 1 = update at key path
 * - kind: 2 = append to array at key path
 * - k = key path (array of strings)
 * - v = value
 */
function applyDelta(state: unknown, delta: unknown): unknown {
	if (!isObject(delta)) {
		return state;
	}

	const kind = (delta as any).kind;
	const k = (delta as any).k;
	const v = (delta as any).v;

	if (kind === 0) {
		return v;
	}

	if (!Array.isArray(k) || k.length === 0) {
		return state;
	}

	const path = k.map(String);
	for (const seg of path) {
		if (!isSafePathSegment(seg)) {
			return state;
		}
	}

	const root: any = isObject(state) ? state : Object.create(null);
	let current: any = root;

	const ensureChildContainer = (parent: any, key: string, nextSeg: string): any => {
		const wantsArray = isArrayIndexSegment(nextSeg);
		let existing = parent[key];
		if (!isObject(existing) && !Array.isArray(existing)) {
			existing = wantsArray ? [] : Object.create(null);
			parent[key] = existing;
		}
		return existing;
	};

	for (let i = 0; i < path.length - 1; i++) {
		const seg = path[i];
		const nextSeg = path[i + 1];

		if (Array.isArray(current) && isArrayIndexSegment(seg)) {
			const idx = Number(seg);
			let existing = current[idx];
			if (!isObject(existing)) {
				existing = isArrayIndexSegment(nextSeg) ? [] : Object.create(null);
				current[idx] = existing;
			}
			current = existing;
			continue;
		}

		if (!isObject(current)) {
			return root;
		}
		current = ensureChildContainer(current, seg, nextSeg);
	}

	const lastSeg = path[path.length - 1];
	if (kind === 1) {
		if (Array.isArray(current) && isArrayIndexSegment(lastSeg)) {
			current[Number(lastSeg)] = v;
			return root;
		}
		if (isObject(current)) {
			Object.defineProperty(current, lastSeg, {
				value: v,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return root;
	}

	if (kind === 2) {
		let target: any;
		if (Array.isArray(current) && isArrayIndexSegment(lastSeg)) {
			const idx = Number(lastSeg);
			if (!Array.isArray(current[idx])) {
				current[idx] = [];
			}
			target = current[idx];
		} else if (isObject(current)) {
			if (!Array.isArray((current as any)[lastSeg])) {
				Object.defineProperty(current, lastSeg, {
					value: [],
					writable: true,
					enumerable: true,
					configurable: true,
				});
			}
			target = (current as any)[lastSeg];
		}

		if (Array.isArray(target)) {
			if (Array.isArray(v)) {
				for (const item of v) {
					target.push(item);
				}
			} else {
				target.push(v);
			}
		}
		return root;
	}

	return root;
}

interface RequestTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Read server-reported token counts from a request's `result.metadata` block.
 * Returns null when the request is pending (no result/metadata, or
 * modelState.value !== 1) so the caller can skip it without counting an
 * interaction. Pure passthrough: any cache split present in metadata is
 * honored verbatim; missing `cacheReadTokens` / `cacheCreationTokens` default
 * to 0, treating every prompt token as fresh input (upper-bound estimate).
 */
function extractRequestTokens(request: unknown): RequestTokens | null {
  if (!isObject(request)) {
    return null;
  }
  const result = (request as any).result;
  if (!isObject(result)) {
    return null;
  }
  const metadata = (result as any).metadata;
  if (!isObject(metadata)) {
    return null;
  }

  // A pending request reports modelState.value !== 1 (in-flight or errored).
  const modelState = (request as any).modelState;
  if (
    isObject(modelState) &&
    typeof (modelState as any).value === 'number' &&
    (modelState as any).value !== 1
  ) {
    return null;
  }

  const promptTokens = clampNonNegInt((metadata as any).promptTokens);
  const outputTokens = clampNonNegInt((metadata as any).outputTokens);

  const rawCacheCreation = (metadata as any).cacheCreationTokens;
  const cacheCreationTokens =
    rawCacheCreation === undefined || rawCacheCreation === null
      ? 0
      : clampNonNegInt(rawCacheCreation);

  const rawCacheRead = (metadata as any).cacheReadTokens;
  const cacheReadTokens =
    rawCacheRead === undefined || rawCacheRead === null
      ? 0
      : clampNonNegInt(rawCacheRead);

  const inputTokens = Math.max(
    0,
    promptTokens - cacheReadTokens - cacheCreationTokens,
  );

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

function getRequestModelId(request: unknown): unknown {
  if (!isObject(request)) {
    return undefined;
  }
  const r = request as any;
  return r.modelId ?? r.selectedModel?.identifier ?? r.model;
}

function processRequests(requests: unknown[]): ParsedSession {
  const modelUsage: ModelUsage = {};
  const modelInteractions: { [model: string]: number } = {};
  let interactions = 0;

  for (const request of requests) {
    if (!isObject(request)) {
      continue;
    }

    const tokens = extractRequestTokens(request);
    if (!tokens) {
      continue;
    }

    const model = normalizeModelFromRequest(getRequestModelId(request));

    interactions += 1;
    modelInteractions[model] = (modelInteractions[model] || 0) + 1;

    let entry = modelUsage[model];
    if (!entry) {
      entry = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      modelUsage[model] = entry;
    }
    entry.inputTokens += tokens.inputTokens;
    entry.outputTokens += tokens.outputTokens;
    entry.cacheReadTokens += tokens.cacheReadTokens;
    entry.cacheCreationTokens += tokens.cacheCreationTokens;
  }

  return { interactions, modelUsage, modelInteractions };
}

const EMPTY_SESSION: ParsedSession = {
  interactions: 0,
  modelUsage: {},
  modelInteractions: {},
};

export interface ParserState {
  sessionState: unknown;
  // Flips true once a syntactically valid delta has been applied. Gates the
  // first-line validity check below — incremental scans against an already-
  // primed state skip the check, full re-parses against a fresh state enforce
  // it. Optional so existing mocks that stub `createParserState` without this
  // field still type-check (a missing flag is treated as `false`).
  hasReceivedDelta?: boolean;
}

export function createParserState(): ParserState {
  return { sessionState: Object.create(null), hasReceivedDelta: false };
}

export function applyDeltaLines(lines: string[], state: ParserState): ParserState {
  let i = 0;
  // First-line validity guard: when state is fresh (no delta yet applied),
  // refuse the whole batch unless the first line parses to a delta object
  // with a numeric `kind`. Without this, a file whose first line is non-delta
  // JSON (or is unparseable) could still feed subsequent kind:1/kind:2
  // deltas into an empty state and fabricate a `requests` tree. Mirrors the
  // pre-existing guard in `parseSessionFileContent` so callers that drive
  // the stateful API directly (e.g. tracker full re-parse) get the same
  // protection.
  if (!state.hasReceivedDelta && lines.length > 0) {
    let first: unknown;
    try {
      first = JSON.parse(lines[0]);
    } catch {
      return state;
    }
    if (!isObject(first) || typeof (first as any).kind !== 'number') {
      return state;
    }
    state.sessionState = applyDelta(state.sessionState, first);
    state.hasReceivedDelta = true;
    i = 1;
  }
  for (; i < lines.length; i++) {
    try {
      const delta = JSON.parse(lines[i]);
      state.sessionState = applyDelta(state.sessionState, delta);
    } catch {
      // Skip invalid lines
    }
  }
  return state;
}

export function aggregateFromState(state: ParserState): ParsedSession {
  const requests =
    isObject(state.sessionState) && Array.isArray((state.sessionState as any).requests)
      ? ((state.sessionState as any).requests as unknown[])
      : [];
  return processRequests(requests);
}

export function parseSessionFileContent(fileContent: string): ParsedSession {
  const lines = fileContent.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return EMPTY_SESSION;
  }
  // applyDeltaLines enforces the first-line validity guard internally for
  // fresh states, so callers don't need to duplicate it here.
  const state = applyDeltaLines(lines, createParserState());
  return aggregateFromState(state);
}
