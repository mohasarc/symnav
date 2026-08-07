export as namespace agentWorkflowRuntime;

interface WorkflowInput {
  readonly agentId: string;
  readonly mode: "draft" | "execute";
  readonly requestedSteps: readonly string[];
}

interface WorkflowPlan {
  readonly title: string;
  readonly agentId: string;
  readonly steps: readonly string[];
}

const defaultSteps = ["plan", "act", "review"];

const defaultWorkflowInput = (): WorkflowInput => ({
  agentId: "agent-alpha",
  mode: "execute",
  requestedSteps: defaultSteps,
});

export const workflowMetadata = {
  owner: "platform",
  hiddenToken: "privateWorkflowSecret",
  labels: ["agent", "workflow"],
};

export class BuildCoordinator {
  run(): WorkflowPlan {
    return buildWorkflow(defaultWorkflowInput());
  }
}

export class AgentBuilder {
  buildTask(step: string): string {
    return `agent:${step}`;
  }
}

export class WorkflowBuilder {
  buildTask(step: string): string {
    return `workflow:${step}`;
  }
}

if (defaultSteps.length > 0) {
  function buildNestedWorkflowAudit(input: WorkflowInput): string {
    return `${input.agentId}:${input.requestedSteps.length}`;
  }

  buildNestedWorkflowAudit(defaultWorkflowInput());
}

/**
 * Workflow JSDoc should not leak into collapsed headers.
 */
export function buildWorkflow(input: WorkflowInput = defaultWorkflowInput()): WorkflowPlan {
  const plan = createPlan(input);
  const assignedAgent = resolveAgent(input.agentId);

  return finalizeWorkflow(plan, assignedAgent);
}

function createPlan(input: WorkflowInput): WorkflowPlan {
  return {
    title: `${input.mode} workflow`,
    agentId: input.agentId,
    steps: input.requestedSteps.map((step) => normalizeStep(step)),
  };
}

function normalizeStep(step: string): string {
  return step.trim().toLowerCase();
}

function resolveAgent(agentId: string): string {
  return agentId.toUpperCase();
}

function finalizeWorkflow(plan: WorkflowPlan, assignedAgent: string): WorkflowPlan {
  return {
    ...plan,
    agentId: assignedAgent,
  };
}

export function runAgentWorkflow(): WorkflowPlan {
  return buildWorkflow(defaultWorkflowInput());
}

export function previewAgentWorkflow(): string {
  const plan = buildWorkflow({ ...defaultWorkflowInput(), mode: "draft" });

  return plan.title;
}

export const workflowFactory = (input: WorkflowInput): WorkflowPlan => buildWorkflow(input);

export class WorkflowRouter {
  dispatch(step: string): string;
  dispatch(step: string, agentId: string): string;
  dispatch(step: string, agentId?: string): string {
    return agentId === undefined ? step : `${agentId}:${step}`;
  }
}

export function describeWorkflowPlan(
  plan: WorkflowPlan,
  assignedAgent: string,
  includeSteps: boolean,
): string {
  const summary = `${plan.title} @ ${assignedAgent}`;

  return includeSteps ? `${summary} [${plan.steps.join(",")}]` : summary;
}

export const workflowAuditor = (plan: WorkflowPlan): string => {
  function auditStep(step: string): string {
    return `${plan.agentId}:${step}`;
  }

  return plan.steps.map(auditStep).join("|");
};

export function summarizeWorkflowSteps(plan: WorkflowPlan): string {
  const parts: string[] = [];

  for (const step of plan.steps) {
    parts.push(step);
  }

  for (let index = 0; index < parts.length; index += 1) {
    parts[index] = parts[index].toUpperCase();
  }

  while (parts.length > 3) {
    parts.pop();
  }

  switch (plan.title) {
    case "draft workflow":
      return parts.join("-");
    default:
      return parts.join("+");
  }
}
