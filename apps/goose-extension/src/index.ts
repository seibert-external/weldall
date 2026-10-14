#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WeldallCli, resolveCli } from "./cli.js";
import { createServer } from "./server.js";
import { safeError } from "./errors.js";
import packageJson from "../package.json" with { type: "json" };

let cli: WeldallCli | undefined;
try {
  cli = new WeldallCli(await resolveCli());
  await cli.initialize();
  const organizationInstructions = await cli.loadOrganizationInstructions();
  const server = createServer(cli, packageJson.version, organizationInstructions);
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 256 * 1024,
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await cli?.close();
      await server.close();
      // Pausing an oversized, partially consumed pipe can keep the process alive.
      process.stdin.destroy();
    })());
  server.onclose = () => {
    void close();
  };
  server.onerror = () => {
    process.stderr.write("Invalid MCP input; closing the session.\n");
    process.exitCode = 1;
    void close();
  };
  process.stdin.once("end", () => {
    void close();
  });
  process.stdout.once("error", () => {
    void close();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void close();
    });
  await server.connect(transport);
} catch (error) {
  await cli?.close();
  process.stderr.write(safeError(error).message + "\n");
  process.exitCode = 1;
}
