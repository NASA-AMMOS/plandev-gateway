/** The common PlanDev error format (NASA-AMMOS/plandev#1732), as merlin's FormattedError serializes it. */
export type FormattedError = {
  cause?: string;
  data?: unknown;
  message: string;
  service?: string;
  /** ISO 8601 UTC. */
  timestamp: string;
  trace?: string;
  /** Short category in caps and underscores, e.g. `PLAN_IMPORT_ERROR`. */
  type: string;
};

export function formatError(error: unknown, type: string): FormattedError {
  const { message, stack } = error instanceof Error ? error : new Error(String(error));

  return { message, service: 'gateway', timestamp: new Date().toISOString(), trace: stack, type };
}
