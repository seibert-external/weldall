import { createHash } from "node:crypto";
import {
  DISCOVERY_LIMITS,
  assertMcpJson,
  nativeDiscoveryRequestSchema,
  nativeDiscoveryResponseSchema,
  mcpDependencyKey,
  mcpToolsResponseSchema,
  mcpResourcesResponseSchema,
  parseMcpResponse,
  type NativeDiscoveryRequest,
  type NativeDiscoveryResponse,
  type DiscoveryEntry,
  type SkillMcpDependency,
} from "@weldall/sdk/mcp";
import type { WeldallConfig } from "../config.js";
import { CliError } from "../errors.js";
import { listScopesWithSubject } from "./resources.js";
import { loadNativeMcpCatalog, resolveNativeMcp } from "./native-mcp.js";
import { listConnectors, listConnections } from "./connections.js";
import { listSkillsWithSubject, showSkillWithSubject } from "./skills.js";
import { requestMcp } from "./mcp.js";

type Summary = Pick<
  DiscoveryEntry,
  "id" | "kind" | "key" | "name" | "description" | "direct" | "viaSkills"
>;
type Selection = { summary: Summary; dependency: SkillMcpDependency };
const summary = (
  kind: Summary["kind"],
  key: string,
  name = key,
  description = "",
  id = `${kind}:${key}`,
): Summary => ({
  kind,
  key,
  name,
  description: description.slice(0, 2000),
  id,
  direct: true,
  viaSkills: [],
});
const unavailable = (
  { id, kind, key, name, description, direct, viaSkills }: Summary,
  code: Extract<DiscoveryEntry, { status: "unavailable" }>["code"] = "source_unavailable",
): DiscoveryEntry => ({
  id,
  kind,
  key,
  name,
  description,
  direct,
  viaSkills,
  status: "unavailable",
  code,
});

/** The sole resolver for new discovery and skill activation. Only the extension publishes. */
export async function discoverNativeResources(
  config: WeldallConfig,
  input: NativeDiscoveryRequest,
  abort?: AbortSignal,
): Promise<NativeDiscoveryResponse> {
  const request = nativeDiscoveryRequestSchema.parse(input);
  const signal = AbortSignal.any([
    AbortSignal.timeout(DISCOVERY_LIMITS.deadlineMs),
    ...(abort ? [abort] : []),
  ]);
  signal.throwIfAborted();
  const snapshot = await listScopesWithSubject(config, signal, Boolean(request.query));
  const subject = snapshot.subject;
  if (
    (request.expectedIssuer !== undefined && request.expectedIssuer !== config.issuer) ||
    (request.expectedSubject !== undefined && request.expectedSubject !== subject)
  )
    return {
      schemaVersion: 1,
      issuer: config.issuer,
      subject,
      results: [],
      resetRequired: "identity_changed",
    };
  const response: NativeDiscoveryResponse = {
    schemaVersion: 1,
    issuer: config.issuer,
    subject,
    results: [],
  };
  const scopes = { signal, expectedSubject: subject };
  const catalogs = new Map<string, Promise<unknown>>();
  const loadConnectorCatalog = (
    operation: "tools" | "resources",
    connectorKey: string,
    connection: string,
  ) => {
    const key = JSON.stringify([operation, connectorKey, connection]);
    let pending = catalogs.get(key);
    if (!pending) {
      pending = requestMcp(
        config,
        operation,
        { connectorKey, connection, expectedSubject: subject, expectedIssuer: config.issuer },
        signal,
      );
      catalogs.set(key, pending);
    }
    return pending;
  };
  // Catalog promises are shared only within this request; cancellation never affects another chat.
  let connectorCatalog: Promise<Awaited<ReturnType<typeof listConnectors>>> | undefined;
  let accountCatalog: Promise<Awaited<ReturnType<typeof listConnections>>> | undefined;
  const connectors = () =>
    (connectorCatalog ??= listConnectors(config, scopes).then((rows) => {
      assertMcpJson(rows);
      if (rows.length > 1000) throw new Error("capacity");
      return rows.filter((row) => row.capabilities?.includes("mcp"));
    }));
  const accounts = () =>
    (accountCatalog ??= listConnections(config, scopes).then((rows) => {
      assertMcpJson(rows);
      if (rows.length > 200) throw new Error("capacity");
      return rows;
    }));
  let skillCatalog: Promise<Awaited<ReturnType<typeof listSkillsWithSubject>>> | undefined;
  const skills = () =>
    (skillCatalog ??= listSkillsWithSubject(config, signal).then((value) => {
      if (value.subject !== subject) throw new Error("identity_changed");
      assertMcpJson(value.result);
      return value;
    }));
  const selected = new Map<string, Selection>();
  const selectedSkills = new Map<string, Summary>();
  const add = (dep: SkillMcpDependency, direct: boolean, skill?: string, hint?: Summary) => {
    const id = mcpDependencyKey(dep);
    const previous = selected.get(id);
    if (previous) {
      previous.summary.direct ||= direct;
      if (skill && !previous.summary.viaSkills.includes(skill))
        previous.summary.viaSkills.push(skill);
      if ("connectorKey" in dep && "connectorKey" in previous.dependency) {
        previous.dependency = {
          ...dep,
          tools: [...new Set([...dep.tools, ...previous.dependency.tools])].sort(),
          includeResources: dep.includeResources || previous.dependency.includeResources,
        };
      }
      return id;
    }
    const key =
      "connectorKey" in dep
        ? dep.connectorKey
        : dep.kind === "resource"
          ? dep.resourceKey
          : dep.connectorType;
    selected.set(id, {
      dependency: dep,
      summary: {
        ...(hint ??
          summary(
            "kind" in dep && dep.kind === "resource" ? "resource" : "connector",
            key,
            key,
            "",
            id,
          )),
        direct,
        viaSkills: skill ? [skill] : [],
      },
    });
    return id;
  };
  for (const key of request.resources) add({ kind: "resource", resourceKey: key }, true);
  for (const connectorType of request.connectorTypes)
    add({ kind: "connector", connectorType }, true);
  for (const dependency of request.dependencies ?? []) add(dependency, true);
  for (const key of request.skills) selectedSkills.set(key, summary("skill", key));
  if (request.query) {
    const query = request.query.toLowerCase();
    const candidates: { summary: Summary; dep?: SkillMcpDependency }[] = snapshot.result.resources
      .filter(
        (resource) =>
          resource.mcp &&
          resource.mcp.discoveryScopes.every((scope) => resource.grantedScopes.includes(scope)) &&
          `${resource.key} ${resource.name} ${resource.mcp.description}`
            .toLowerCase()
            .includes(query),
      )
      .map((resource) => ({
        summary: summary("resource", resource.key, resource.name, resource.mcp!.description),
        dep: { kind: "resource", resourceKey: resource.key },
      }));
    const catalogResults = await Promise.allSettled([connectors(), skills()]);
    response.warnings = catalogResults.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            index === 0
              ? ("connector_catalog_unavailable" as const)
              : ("skill_catalog_unavailable" as const),
          ]
        : [],
    );
    const connectorResult = catalogResults[0];
    if (connectorResult.status === "fulfilled") {
      for (const type of [...new Set(connectorResult.value.map((row) => row.type))].sort()) {
        const rows = connectorResult.value.filter((row) => row.type === type);
        if (rows.some((row) => `${row.key} ${row.name} ${row.type}`.toLowerCase().includes(query)))
          candidates.push({
            summary: summary(
              "connector",
              type,
              rows
                .map((row) => row.name)
                .join(", ")
                .slice(0, 200),
              type,
              `connector-type:${type}`,
            ),
            dep: { kind: "connector", connectorType: type },
          });
      }
    }
    const skillResult = catalogResults[1];
    if (skillResult.status === "fulfilled")
      for (const item of skillResult.value.result.items) {
        if (
          item.available &&
          `${item.slug} ${item.title} ${item.preview} ${item.meta?.tags?.join(" ") ?? ""}`
            .toLowerCase()
            .includes(query)
        )
          candidates.push({ summary: summary("skill", item.slug, item.title, item.preview) });
      }
    candidates.sort((a, b) =>
      a.summary.id < b.summary.id ? -1 : a.summary.id > b.summary.id ? 1 : 0,
    );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([config.issuer, subject, query, candidates.map((item) => item.summary)]),
      )
      .digest("hex");
    let offset = 0;
    if (request.cursor) {
      const [revision, position] = request.cursor.split(":");
      if (revision !== fingerprint)
        throw new CliError("Discovery catalog changed; search again without the cursor.");
      offset = Number(position);
      if (offset >= candidates.length) throw new CliError("Invalid discovery cursor");
    }
    const page = candidates.slice(offset, offset + DISCOVERY_LIMITS.sources);
    for (const candidate of page) {
      if (candidate.dep) add(candidate.dep, true, undefined, candidate.summary);
      else selectedSkills.set(candidate.summary.key, candidate.summary);
    }
    if (offset + page.length < candidates.length)
      response.nextCursor = `${fingerprint}:${offset + page.length}`;
  } else if (request.cursor) throw new CliError("A discovery cursor requires a query");

  const skillEntries: DiscoveryEntry[] = [];
  let instructionBytes = 0;
  for (const [key, hint] of selectedSkills) {
    try {
      signal.throwIfAborted();
      const catalog = await skills();
      const item = catalog.result.items.find((row) => row.slug === key && row.available);
      if (!item) throw new Error("unavailable");
      const source = summary("skill", key, item.title, item.preview);
      if (request.catalogOnly) {
        skillEntries.push({ ...source, status: "catalog" });
        continue;
      }
      const loaded = await showSkillWithSubject(config, key, signal);
      if (loaded.subject !== subject || loaded.result.slug !== key || !loaded.result.available)
        throw new Error("unavailable");
      const size = Buffer.byteLength(loaded.result.document, "utf8");
      if (instructionBytes + size > DISCOVERY_LIMITS.instructionBytes) {
        skillEntries.push(unavailable(source, "capacity"));
        continue;
      }
      instructionBytes += size;
      const dependencies = (loaded.result.mcpDependencies ?? []).map((dependency) =>
        add(dependency, false, key),
      );
      skillEntries.push({
        ...source,
        kind: "skill",
        status: "resolved",
        document: loaded.result.document,
        dependencies,
      });
    } catch {
      skillEntries.push(unavailable(hint, signal.aborted ? "cancelled" : "source_unavailable"));
    }
  }

  const selections = [...selected.values()].sort((a, b) => (a.summary.id < b.summary.id ? -1 : 1));
  const resolved = new Map<string, string>();
  const values: DiscoveryEntry[] = selections.map((source) =>
    unavailable(source.summary, "capacity"),
  );
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(DISCOVERY_LIMITS.concurrency, selections.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= Math.min(selections.length, DISCOVERY_LIMITS.sources)) break;
        const { summary: source, dependency } = selections[index]!;
        try {
          signal.throwIfAborted();
          if ("kind" in dependency && dependency.kind === "resource") {
            if (request.query && request.catalogOnly) {
              values[index] = { ...source, status: "catalog" };
              continue;
            }
            const native = await resolveNativeMcp(config, dependency.resourceKey, signal, snapshot);
            if (native.subject !== subject) throw new Error("identity_changed");
            const metadata = {
              ...source,
              name: native.resource.name,
              description: native.metadata.description,
            };
            values[index] = request.catalogOnly
              ? { ...metadata, status: "catalog" }
              : {
                  ...metadata,
                  kind: "resource",
                  status: "resolved",
                  route: {
                    resourceKey: dependency.resourceKey,
                    resourceIdentifier: native.resource.resourceIdentifier,
                    revision: native.metadata.revision,
                  },
                  ...(await loadNativeMcpCatalog(config, native, signal)),
                };
            continue;
          }
          const availableConnectors = (await connectors()).filter((row) =>
            "connectorKey" in dependency
              ? row.key === dependency.connectorKey
              : row.type === dependency.connectorType,
          );
          if (!availableConnectors.length) throw new Error("unavailable");
          if (request.catalogOnly) {
            values[index] = {
              ...source,
              name: availableConnectors
                .map((row) => row.name)
                .join(", ")
                .slice(0, 200),
              status: "catalog",
            };
            continue;
          }
          const catalog = await accounts();
          const candidates = catalog.filter(
            (account) =>
              availableConnectors.some((row) => row.key === account.connectorKey) &&
              account.connectorEnabled &&
              account.status === "READY" &&
              account.capabilities?.includes("mcp"),
          );
          const bindings = request.bindings.filter(
            (binding) =>
              binding.selector === source.id ||
              availableConnectors.some((row) => row.key === binding.connectorKey),
          );
          const own = bindings.find((binding) => binding.selector === source.id);
          const bound =
            own ??
            (new Set(bindings.map((binding) => `${binding.connectorKey}:${binding.connectionId}`))
              .size === 1
              ? bindings[0]
              : undefined);
          const chosen =
            request.selection &&
            availableConnectors.some((row) => row.key === request.selection!.connectorKey)
              ? candidates.find(
                  (account) =>
                    account.connectorKey === request.selection!.connectorKey &&
                    account.id === request.selection!.connection,
                )
              : undefined;
          if (
            request.selection &&
            availableConnectors.some((row) => row.key === request.selection!.connectorKey) &&
            !chosen
          )
            throw new Error("selection_unavailable");
          if (
            bound &&
            chosen &&
            (chosen.id !== bound.connectionId || chosen.connectorKey !== bound.connectorKey)
          )
            throw new Error("rebind");
          const account = bound
            ? candidates.find(
                (row) => row.id === bound.connectionId && row.connectorKey === bound.connectorKey,
              )
            : (chosen ??
              (catalog.length < 200 && candidates.length === 1 ? candidates[0] : undefined));
          if (bound && !account) {
            values[index] = unavailable(source, "bound_connection_unavailable");
            continue;
          }
          if (!account) {
            values[index] =
              candidates.length || catalog.length >= 200
                ? {
                    ...source,
                    kind: "connector",
                    status: "selection_required",
                    catalogComplete: catalog.length < 200,
                    choices: candidates.map((row) => ({
                      connectorKey: row.connectorKey,
                      connectorName: availableConnectors.find(
                        (item) => item.key === row.connectorKey,
                      )!.name,
                      connectionId: row.id,
                      name: row.name,
                      accountName: row.accountName,
                    })),
                  }
                : unavailable(source, "connection_required");
            continue;
          }
          const connector = availableConnectors.find((row) => row.key === account.connectorKey)!;
          const route = {
            connectorKey: connector.key,
            connectorType: connector.type,
            connectionId: account.id,
          };
          const tools = parseMcpResponse(
            mcpToolsResponseSchema,
            await loadConnectorCatalog("tools", connector.key, account.id),
          ).tools;
          const whole =
            !("connectorKey" in dependency) || bindings.some((binding) => binding.whole);
          const selectedTools = [
            ...new Set([
              ...("connectorKey" in dependency ? dependency.tools : []),
              ...bindings.flatMap((binding) => binding.tools),
            ]),
          ];
          const requiredTools = whole
            ? "connectorKey" in dependency
              ? dependency.tools
              : []
            : selectedTools;
          if (requiredTools.some((name) => !tools.some((tool) => tool.name === name)))
            throw new Error("missing_tool");
          const resources =
            whole ||
            ("connectorKey" in dependency && dependency.includeResources) ||
            bindings.some((binding) => binding.includeResources)
              ? parseMcpResponse(
                  mcpResourcesResponseSchema,
                  await loadConnectorCatalog("resources", connector.key, account.id),
                ).resources
              : [];
          const id = `connector:${connector.key}`;
          resolved.set(source.id, id);
          values[index] = {
            ...source,
            kind: "connector",
            id,
            key: connector.key,
            name: connector.name,
            status: "resolved",
            route,
            whole,
            selectors: [source.id],
            tools: whole ? tools : tools.filter((tool) => selectedTools.includes(tool.name)),
            resources,
          };
        } catch {
          values[index] = unavailable(source, signal.aborted ? "cancelled" : "source_unavailable");
        }
      }
    }),
  );
  const failedSelectors = new Set(
    values.filter((entry) => entry.status !== "resolved").map((entry) => entry.id),
  );
  const entries = new Map<string, DiscoveryEntry>();
  for (const entry of values) {
    const previous = entries.get(entry.id);
    if (
      previous?.kind === "connector" &&
      previous.status === "resolved" &&
      entry.kind === "connector" &&
      entry.status === "resolved"
    ) {
      if (previous.route.connectionId !== entry.route.connectionId) {
        entries.set(entry.id, unavailable(entry, "bound_connection_unavailable"));
        continue;
      }
      previous.selectors.push(...entry.selectors);
      previous.whole ||= entry.whole;
      previous.direct ||= entry.direct;
      previous.viaSkills = [...new Set([...previous.viaSkills, ...entry.viaSkills])];
      previous.tools = [
        ...new Map([...previous.tools, ...entry.tools].map((tool) => [tool.name, tool])).values(),
      ];
      previous.resources = [
        ...new Map(
          [...previous.resources, ...entry.resources].map((resource) => [resource.uri, resource]),
        ).values(),
      ];
    } else if (previous?.status !== "resolved") entries.set(entry.id, entry);
  }
  let tools = 0,
    resources = 0;
  const complete = [...entries.values(), ...skillEntries];
  // Reserve every failure/skill outcome before admitting any definitions.
  response.results = complete.map((entry) =>
    entry.status === "resolved" && entry.kind !== "skill" ? unavailable(entry, "capacity") : entry,
  );
  for (const [index, entry] of complete.entries()) {
    if (entry.status !== "resolved" || entry.kind === "skill") continue;
    try {
      tools += entry.tools.length;
      resources += entry.resources.length;
      response.results[index] = entry;
      if (tools > DISCOVERY_LIMITS.tools || resources > DISCOVERY_LIMITS.resources)
        throw new Error("capacity");
      assertMcpJson(response, DISCOVERY_LIMITS.bytes);
    } catch {
      tools -= entry.tools.length;
      resources -= entry.resources.length;
      response.results[index] = unavailable(entry, "capacity");
    }
  }
  for (const entry of response.results)
    if (entry.kind === "skill" && entry.status === "resolved") {
      if (
        entry.dependencies.some(
          (id) =>
            failedSelectors.has(id) ||
            !response.results.some(
              (source) => source.id === (resolved.get(id) ?? id) && source.status === "resolved",
            ),
        )
      )
        entry.status = "incomplete";
      entry.dependencies = entry.dependencies.map((id) => resolved.get(id) ?? id);
    }
  assertMcpJson(response, DISCOVERY_LIMITS.bytes);
  return nativeDiscoveryResponseSchema.parse(response);
}
