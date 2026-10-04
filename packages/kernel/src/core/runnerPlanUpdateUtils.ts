import { parseToolArguments } from './toolArgsParser.js';

type ToolCallLike = {
  id: string;
  function: {
    name?: string;
    arguments?: string;
  };
};

type ToolResultLike = {
  id: string;
  name: string;
  success: boolean;
  output: unknown;
};

export function extractPlanUpdatePayload(
  result: ToolResultLike,
  toolCalls: ToolCallLike[],
): { explanation?: string; plan: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }> } | null {
  if ((result.name !== 'update_plan' && result.name !== 'call_tool') || !result.success) {
    return null;
  }

  const originalCall = toolCalls.find(tc => tc.id === result.id);
  if (!originalCall) {
    return null;
  }

  const parsedArgs = parseToolArguments(originalCall.function.arguments || '{}', originalCall.function.name);
  if (!parsedArgs.ok) {
    return null;
  }
  const args = parsedArgs.args;

  /* Accept nested argument wrappers so an update_plan payload can still expose
     its plan array when providers add an arguments, params, or input layer. */
  let planArgs: any = null;
  if (result.name === 'update_plan') {
    planArgs = args;
  } else if (result.name === 'call_tool' && args?.name === 'update_plan') {
    planArgs = args.args ?? args.arguments ?? args.input ?? args.params;
  }
  /* 仍找不到 plan 数组就再深挖一层 — args 嵌套层级最多 2 层够用 */
  if (planArgs && !Array.isArray(planArgs.plan)) {
    const nested = planArgs.args ?? planArgs.arguments ?? planArgs.input ?? planArgs.params;
    if (nested && Array.isArray(nested.plan)) planArgs = nested;
  }
  if (!planArgs || !Array.isArray(planArgs.plan)) {
    return null;
  }

  let outputOk = true;
  if (typeof result.output === 'string') {
    try {
      const parsedOutput = JSON.parse(result.output);
      if (parsedOutput && typeof parsedOutput === 'object' && 'success' in parsedOutput) {
        outputOk = parsedOutput.success !== false;
      }
    } catch {
      // ignore output parse failure
    }
  }
  if (!outputOk) {
    return null;
  }

  return {
    explanation: planArgs.explanation,
    plan: planArgs.plan,
  };
}
