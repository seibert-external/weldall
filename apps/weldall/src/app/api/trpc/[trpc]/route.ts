import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { after } from "next/server";
import { createContext } from "@/server/trpc/context";
import { refreshDueCatalogs } from "@/server/skills/catalogs";
import { appRouter } from "@/server/trpc/router";

const handler = (request: Request) => {
  after(() => refreshDueCatalogs());
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: () => createContext(request),
  });
};

export { handler as GET, handler as POST };
