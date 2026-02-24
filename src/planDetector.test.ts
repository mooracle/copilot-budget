import * as vscode from 'vscode';
import {
  parseApiResponse,
  detectPlan,
  getPlanInfo,
  onPlanChanged,
  startPeriodicRefresh,
  stopPeriodicRefresh,
  disposePlanDetector,
  DEFAULT_COST_PER_REQUEST,
  PLAN_COSTS,
  PlanInfo,
} from './planDetector';
import { __configStore } from './__mocks__/vscode';

jest.mock('./logger');

const mockAuth = vscode.authentication as unknown as { getSession: jest.Mock };

// Mock global fetch
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  disposePlanDetector();
  // Reset config
  delete __configStore['copilot-budget.plan'];
  // Default: no auth session
  mockAuth.getSession.mockResolvedValue(null);
  mockFetch.mockReset();
});

afterEach(() => {
  stopPeriodicRefresh();
  jest.useRealTimers();
});

describe('parseApiResponse', () => {
  it('returns null for non-object input', () => {
    expect(parseApiResponse(null)).toBeNull();
    expect(parseApiResponse(undefined)).toBeNull();
    expect(parseApiResponse('string')).toBeNull();
    expect(parseApiResponse(42)).toBeNull();
  });

  it('returns null when copilot_plan is missing', () => {
    expect(parseApiResponse({})).toBeNull();
    expect(parseApiResponse({ other_field: 'value' })).toBeNull();
  });

  it('returns null when copilot_plan is empty string', () => {
    expect(parseApiResponse({ copilot_plan: '' })).toBeNull();
  });

  it('returns null when copilot_plan is not a string', () => {
    expect(parseApiResponse({ copilot_plan: 123 })).toBeNull();
    expect(parseApiResponse({ copilot_plan: true })).toBeNull();
  });

  it('maps individual_pro to pro plan', () => {
    const result = parseApiResponse({ copilot_plan: 'individual_pro' });
    expect(result).toEqual({
      planName: 'pro',
      costPerRequest: PLAN_COSTS.pro.costPerRequest,
      source: 'api',
    });
  });

  it('maps individual_free to free plan', () => {
    const result = parseApiResponse({ copilot_plan: 'individual_free' });
    expect(result).toEqual({
      planName: 'free',
      costPerRequest: 0,
      source: 'api',
    });
  });

  it('maps individual_pro_plus to pro+ plan', () => {
    const result = parseApiResponse({ copilot_plan: 'individual_pro_plus' });
    expect(result).toEqual({
      planName: 'pro+',
      costPerRequest: PLAN_COSTS['pro+'].costPerRequest,
      source: 'api',
    });
  });

  it('maps business plan', () => {
    const result = parseApiResponse({ copilot_plan: 'business' });
    expect(result).toEqual({
      planName: 'business',
      costPerRequest: PLAN_COSTS.business.costPerRequest,
      source: 'api',
    });
  });

  it('maps enterprise plan', () => {
    const result = parseApiResponse({ copilot_plan: 'enterprise' });
    expect(result).toEqual({
      planName: 'enterprise',
      costPerRequest: PLAN_COSTS.enterprise.costPerRequest,
      source: 'api',
    });
  });

  it('returns null for unknown plan name', () => {
    expect(parseApiResponse({ copilot_plan: 'unknown_plan_xyz' })).toBeNull();
  });
});

describe('detectPlan', () => {
  it('uses config setting when not auto', async () => {
    __configStore['copilot-budget.plan'] = 'pro';

    const plan = await detectPlan();

    expect(plan.planName).toBe('pro');
    expect(plan.source).toBe('config');
    expect(plan.costPerRequest).toBe(PLAN_COSTS.pro.costPerRequest);
    expect(mockAuth.getSession).not.toHaveBeenCalled();
  });

  it('uses API when config is auto and auth succeeds', async () => {
    __configStore['copilot-budget.plan'] = 'auto';
    mockAuth.getSession.mockResolvedValue({
      accessToken: 'test-token',
      id: 'test',
      scopes: ['user:email'],
      account: { id: '1', label: 'test' },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ copilot_plan: 'individual_pro' }),
    });

    const plan = await detectPlan();

    expect(plan.planName).toBe('pro');
    expect(plan.source).toBe('api');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/copilot_internal/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });

  it('falls back to default when no auth session', async () => {
    const plan = await detectPlan();

    expect(plan.planName).toBe('unknown');
    expect(plan.source).toBe('default');
    expect(plan.costPerRequest).toBe(DEFAULT_COST_PER_REQUEST);
  });

  it('falls back to default when API returns error', async () => {
    mockAuth.getSession.mockResolvedValue({
      accessToken: 'test-token',
      id: 'test',
      scopes: ['user:email'],
      account: { id: '1', label: 'test' },
    });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
    });

    const plan = await detectPlan();

    expect(plan.planName).toBe('unknown');
    expect(plan.source).toBe('default');
  });

  it('falls back to default when fetch throws', async () => {
    mockAuth.getSession.mockResolvedValue({
      accessToken: 'test-token',
      id: 'test',
      scopes: ['user:email'],
      account: { id: '1', label: 'test' },
    });
    mockFetch.mockRejectedValue(new Error('Network error'));

    const plan = await detectPlan();

    expect(plan.planName).toBe('unknown');
    expect(plan.source).toBe('default');
  });

  it('falls back to default when API returns unknown plan', async () => {
    mockAuth.getSession.mockResolvedValue({
      accessToken: 'test-token',
      id: 'test',
      scopes: ['user:email'],
      account: { id: '1', label: 'test' },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ copilot_plan: 'some_future_plan' }),
    });

    const plan = await detectPlan();

    expect(plan.planName).toBe('unknown');
    expect(plan.source).toBe('default');
  });

  it('config setting overrides API (config takes priority)', async () => {
    __configStore['copilot-budget.plan'] = 'enterprise';

    const plan = await detectPlan();

    expect(plan.planName).toBe('enterprise');
    expect(plan.source).toBe('config');
    // Should not even attempt API call
    expect(mockAuth.getSession).not.toHaveBeenCalled();
  });
});

describe('getPlanInfo', () => {
  it('returns default plan info before detectPlan is called', () => {
    const plan = getPlanInfo();
    expect(plan.planName).toBe('unknown');
    expect(plan.costPerRequest).toBe(DEFAULT_COST_PER_REQUEST);
    expect(plan.source).toBe('default');
  });

  it('returns cached plan after detectPlan', async () => {
    __configStore['copilot-budget.plan'] = 'pro';
    await detectPlan();

    const plan = getPlanInfo();
    expect(plan.planName).toBe('pro');
    expect(plan.source).toBe('config');
  });
});

describe('onPlanChanged', () => {
  it('fires listener when plan changes', async () => {
    const listener = jest.fn();
    onPlanChanged(listener);

    __configStore['copilot-budget.plan'] = 'pro';
    await detectPlan();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ planName: 'pro', source: 'config' }),
    );
  });

  it('does not fire listener when plan stays the same', async () => {
    __configStore['copilot-budget.plan'] = 'pro';
    await detectPlan();

    const listener = jest.fn();
    onPlanChanged(listener);

    // Detect again with same config
    await detectPlan();

    expect(listener).not.toHaveBeenCalled();
  });

  it('removes listener on dispose', async () => {
    const listener = jest.fn();
    const sub = onPlanChanged(listener);
    sub.dispose();

    __configStore['copilot-budget.plan'] = 'pro';
    await detectPlan();

    expect(listener).not.toHaveBeenCalled();
  });

  it('supports multiple listeners', async () => {
    const listener1 = jest.fn();
    const listener2 = jest.fn();
    onPlanChanged(listener1);
    onPlanChanged(listener2);

    __configStore['copilot-budget.plan'] = 'business';
    await detectPlan();

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
  });
});

describe('periodic refresh', () => {
  it('calls detectPlan on interval', async () => {
    __configStore['copilot-budget.plan'] = 'pro';
    await detectPlan();

    const listener = jest.fn();
    onPlanChanged(listener);

    startPeriodicRefresh();

    // Change config so next detect triggers listener
    __configStore['copilot-budget.plan'] = 'enterprise';

    // Advance by 15 minutes
    jest.advanceTimersByTime(15 * 60 * 1000);

    // Need to flush promises for async detectPlan
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stopPeriodicRefresh stops the timer', async () => {
    startPeriodicRefresh();
    stopPeriodicRefresh();

    const listener = jest.fn();
    onPlanChanged(listener);

    __configStore['copilot-budget.plan'] = 'pro';
    jest.advanceTimersByTime(15 * 60 * 1000);
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('disposePlanDetector', () => {
  it('resets plan to default and clears listeners', async () => {
    __configStore['copilot-budget.plan'] = 'pro';
    await detectPlan();
    expect(getPlanInfo().planName).toBe('pro');

    const listener = jest.fn();
    onPlanChanged(listener);

    disposePlanDetector();

    expect(getPlanInfo().planName).toBe('unknown');
    expect(getPlanInfo().costPerRequest).toBe(DEFAULT_COST_PER_REQUEST);

    // Listener should have been cleared
    __configStore['copilot-budget.plan'] = 'enterprise';
    await detectPlan();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('PLAN_COSTS', () => {
  it('has correct cost per request for each plan', () => {
    expect(PLAN_COSTS.free.costPerRequest).toBe(0);
    expect(PLAN_COSTS.pro.costPerRequest).toBeCloseTo(0.0333, 3);
    expect(PLAN_COSTS['pro+'].costPerRequest).toBe(39 / 1500);
    expect(PLAN_COSTS.business.costPerRequest).toBeCloseTo(0.0633, 3);
    expect(PLAN_COSTS.enterprise.costPerRequest).toBe(39 / 1000);
  });
});
