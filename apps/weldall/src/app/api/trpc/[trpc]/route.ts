import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { after } from "next/server";
import { createContext } from "@/server/trpc/context";
import { refreshDueCatalogs } from "@/server/skills/catalogs";
import { appRouter } from "@/server/trpc/router";
import { withRequestLogging } from "@/server/observability/http";

const handler = (request: Request) => {
  after(() => refreshDueCatalogs());
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: () => createContext(request),
  });
};

export const GET = withRequestLogging("/api/trpc/[trpc]", handler, {
  successLevel: "debug",
});
export const POST = withRequestLogging("/api/trpc/[trpc]", handler, {
  successLevel: "debug",
});
