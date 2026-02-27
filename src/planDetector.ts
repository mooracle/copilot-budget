import * as vscode from 'vscode';
import { log } from './logger';
import { getPlanSetting } from './config';

export interface PlanInfo {
  planName: string;
  costPerRequest: number;
  source: 'api' | 'config' | 'default';
}

export interface PlanCostEntry {
  costPerRequest: number;
  monthlyPrice: number;
  includedRequests: number;
}

export const DEFAULT_COST_PER_REQUEST = 0.04;

export const PLAN_COSTS: Record<string, PlanCostEntry> = {
  free: { costPerRequest: 0, monthlyPrice: 0, includedRequests: 50 },
  pro: { costPerRequest: 10 / 300, monthlyPrice: 10, includedRequests: 300 },
  'pro+': { costPerRequest: 39 / 1500, monthlyPrice: 39, includedRequests: 1500 },
  business: { costPerRequest: 19 / 300, monthlyPrice: 19, includedRequests: 300 },
  enterprise: { costPerRequest: 39 / 1000, monthlyPrice: 39, includedRequests: 1000 },
};

const DEFAULT_PLAN_INFO: PlanInfo = {
  planName: 'unknown',
  costPerRequest: DEFAULT_COST_PER_REQUEST,
  source: 'default',
};

// Maps API copilot_plan values to our plan names
const API_PLAN_MAP: Record<string, string> = {
  individual_free: 'free',
  individual_pro: 'pro',
  individual_pro_plus: 'pro+',
  business: 'business',
  enterprise: 'enterprise',
};

let currentPlan: PlanInfo = { ...DEFAULT_PLAN_INFO };
let listeners: Array<(plan: PlanInfo) => void> = [];
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function parseApiResponse(data: unknown): PlanInfo | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const obj = data as Record<string, unknown>;
  const copilotPlan = obj.copilot_plan;

  if (typeof copilotPlan !== 'string' || copilotPlan === '') {
    return null;
  }

  const planName = API_PLAN_MAP[copilotPlan] ?? copilotPlan;
  const planCost = PLAN_COSTS[planName];

  if (!planCost) {
    log(`planDetector: unrecognized plan '${copilotPlan}' from API`);
    return null;
  }

  return {
    planName,
    costPerRequest: planCost.costPerRequest,
    source: 'api',
  };
}

function planFromConfig(setting: string): PlanInfo | null {
  if (setting === 'auto') {
    return null;
  }
  const planCost = PLAN_COSTS[setting];
  if (!planCost) {
    return null;
  }
  return {
    planName: setting,
    costPerRequest: planCost.costPerRequest,
    source: 'config',
  };
}

async function detectFromApi(): Promise<PlanInfo | null> {
  try {
    const session = await vscode.authentication.getSession('github', ['user:email'], {
      createIfNone: false,
    });
    if (!session) {
      log('planDetector: no GitHub session available');
      return null;
    }

    const response = await fetch('https://api.github.com/copilot_internal/user', {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'copilot-budget-vscode',
      },
    });

    if (!response.ok) {
      log(`planDetector: API returned ${response.status}`);
      return null;
    }

    const data = await response.json();
    return parseApiResponse(data);
  } catch (err) {
    log(`planDetector: API detection failed: ${err}`);
    return null;
  }
}

export async function detectPlan(): Promise<PlanInfo> {
  const plan = planFromConfig(getPlanSetting())
    ?? await detectFromApi()
    ?? { ...DEFAULT_PLAN_INFO };
  updatePlan(plan);
  return plan;
}

function updatePlan(newPlan: PlanInfo): void {
  const changed =
    currentPlan.planName !== newPlan.planName ||
    currentPlan.costPerRequest !== newPlan.costPerRequest ||
    currentPlan.source !== newPlan.source;

  currentPlan = newPlan;

  if (changed) {
    log(`planDetector: plan updated to ${newPlan.planName} (${newPlan.source}), cost=$${newPlan.costPerRequest.toFixed(4)}/PR`);
    for (const listener of [...listeners]) {
      listener(newPlan);
    }
  }
}

export function getPlanInfo(): PlanInfo {
  return { ...currentPlan };
}

export function onPlanChanged(listener: (plan: PlanInfo) => void): { dispose: () => void } {
  listeners.push(listener);
  return {
    dispose: () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    },
  };
}

const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function startPeriodicRefresh(): void {
  stopPeriodicRefresh();
  refreshTimer = setInterval(() => {
    detectPlan().catch(() => {});
  }, REFRESH_INTERVAL_MS);
}

export function stopPeriodicRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function disposePlanDetector(): void {
  stopPeriodicRefresh();
  listeners = [];
  currentPlan = { ...DEFAULT_PLAN_INFO };
}
