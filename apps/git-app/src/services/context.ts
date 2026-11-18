import type { AuditReporter } from "../audit.js";
import type { ConfiguredHost } from "../hosts/index.js";
import type { Logger } from "../log.js";
import type { AppHostApi } from "../weldall.js";

/** What every endpoint service works with; built once per instance in `app.ts`. */
export interface GitAppServices {
  host: ConfiguredHost;
  weldall: AppHostApi;
  audit: AuditReporter;
  log: Logger;
  scopes: { publish: string; admin: string };
}

/** The person a request acts for: the verified token's `sub`, a Weldall user id. */
export interface Person {
  id: string;
}
