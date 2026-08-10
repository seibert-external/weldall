import { Hono } from "hono";
import { initWorkloadAuth, type WorkloadVariables } from "@weldall/sdk/hono";
import type { ReplayStore } from "@weldall/sdk";

/** Expenses B fixture for direct Expenses A workload calls. */
export function createExpensesBWorkloadApp(input: {
  weldallIssuer: string;
  resource: string;
  publicOrigin: string;
  allowedClientIds: readonly string[];
  replayStore: ReplayStore;
  readScope?: string;
  createScope?: string;
  deleteScope?: string;
}) {
  const readScope = input.readScope ?? "expenses:read";
  const createScope = input.createScope ?? "expenses:create";
  const deleteScope = input.deleteScope ?? "expenses:delete";
  const workloads = initWorkloadAuth(input.weldallIssuer, {
    resource: input.resource,
    publicOrigin: input.publicOrigin,
    supportedScopes: [readScope, createScope, deleteScope],
    allowedClientIds: input.allowedClientIds,
    replayStore: input.replayStore,
  });
  const app = new Hono<{ Variables: WorkloadVariables }>();
  app.get("/api/internal/expenses", workloads.protectWorkload({ scopes: [readScope] }), (context) =>
    context.json({
      caller: workloads.getWorkloadAuth(context).clientId,
      identityType: workloads.getWorkloadAuth(context).identityType,
      expenses: [{ id: "expense-b-1", amount: 42 }],
    }),
  );
  app.post(
    "/api/internal/expenses",
    workloads.protectWorkload({ scopes: [createScope] }),
    async (context) => context.json({ caller: workloads.getWorkloadAuth(context).clientId }, 201),
  );
  app.delete(
    "/api/internal/expenses/:id",
    workloads.protectWorkload({ scopes: [deleteScope] }),
    (context) => context.json({ deleted: context.req.param("id") }),
  );
  return app;
}
