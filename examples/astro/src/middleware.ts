import { defineMiddleware } from "astro:middleware";
import { weldall } from "./weldall";

const protectExpenses = weldall.protect({ scopes: ["expenses:read"] });
export const onRequest = defineMiddleware((context, next) =>
  context.url.pathname === "/api/expenses" ? protectExpenses(context, next) : next(),
);
