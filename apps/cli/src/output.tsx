import { stripVTControlCharacters } from "node:util";
import { createContext, useContext, type PropsWithChildren, type ReactNode } from "react";
import chalk from "chalk";
import { Box, Text, renderToString } from "ink";

export const palette = {
  primary: "blue",
  success: "green",
  warning: "yellow",
  danger: "red",
  accent: "cyan",
  brand: "magenta",
} as const;

export type Accent = (typeof palette)[keyof typeof palette];
type NoticeKind = "success" | "info" | "warning" | "error";
type OutputStream = "stdout" | "stderr";
type Field = readonly [label: string, value: string];

export interface TableColumn {
  header: string;
  align?: "left" | "right";
}

const TABLE_GAP = 2;

const LayoutContext = createContext(80);
const outputStream = (stream: OutputStream) => process[stream];
const terminalColumns = (stream: OutputStream = "stdout") => outputStream(stream).columns || 80;
const frameColumns = (columns = terminalColumns()) => Math.max(1, Math.min(80, columns));
const colorsEnabled = (stream: OutputStream) =>
  Boolean(outputStream(stream).isTTY) &&
  !("NO_COLOR" in process.env) &&
  process.env.TERM !== "dumb";

export const terminalText = (value: string) => value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "�");
export const terminalDocument = (value: string) =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "�");

/** Renders one Ink tree using the explicit width and color policy of its destination stream. */
const renderUiAtWidth = ({
  node,
  width,
  stream,
}: {
  node: ReactNode;
  width: number;
  stream: OutputStream;
}) => {
  if (width === 1) return "…";
  const previousColorLevel = chalk.level;
  chalk.level = colorsEnabled(stream) ? 1 : 0;
  try {
    const output = renderToString(
      <LayoutContext.Provider value={width}>{node}</LayoutContext.Provider>,
      { columns: width },
    );
    return colorsEnabled(stream) ? output : stripVTControlCharacters(output);
  } finally {
    chalk.level = previousColorLevel;
  }
};

/** Renders Ink UI deterministically for the selected terminal width and output stream. */
export const renderUi = ({
  node,
  columns = terminalColumns(),
  stream = "stdout",
}: {
  node: ReactNode;
  columns?: number;
  stream?: OutputStream;
}) => renderUiAtWidth({ node, width: frameColumns(columns), stream });

export const printUi = (node: ReactNode) => console.log(renderUi({ node }));
export const printWideUi = (node: ReactNode) =>
  console.log(renderUiAtWidth({ node, width: Math.max(1, terminalColumns()), stream: "stdout" }));

export function Card({
  title,
  accent = palette.primary,
  fill = false,
  children,
}: PropsWithChildren<{ title: string; accent?: Accent; fill?: boolean }>) {
  return (
    <Box
      borderStyle="round"
      borderColor={accent}
      flexDirection="column"
      paddingX={1}
      {...(fill ? { height: "100%" as const, width: "100%" as const } : {})}
    >
      <Text bold color={accent}>
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}

/** Allocates terminal table widths without truncating cell content from CLI output. */
export const layoutTable = ({
  columns,
  rows,
  available,
}: {
  columns: readonly TableColumn[];
  rows: readonly (readonly string[])[];
  available: number;
}): number[] => {
  if (columns.length === 0) return [];
  const gaps = TABLE_GAP * (columns.length - 1);
  const widths = columns.map((column, columnIndex) =>
    Math.max(
      column.header.length,
      ...rows.map((row) => terminalText(row[columnIndex] ?? "").length),
    ),
  );
  const floors = columns.map((column) => column.header.length);
  let total = widths.reduce((sum, width) => sum + width, 0) + gaps;
  while (total > available) {
    let target = -1;
    for (let columnIndex = 0; columnIndex < widths.length; columnIndex += 1) {
      const width = widths[columnIndex]!;
      if (width <= floors[columnIndex]!) continue;
      if (target === -1 || width > widths[target]!) target = columnIndex;
    }
    if (target === -1) {
      target = widths.indexOf(Math.max(...widths));
      if (widths[target] === 0) break;
    }
    widths[target] = widths[target]! - 1;
    total--;
  }
  return widths;
};

/** Wraps a sanitized terminal cell without discarding content at narrow widths. */
const wrapTableCell = ({ value, width }: { value: string; width: number }) => {
  const text = terminalText(value);
  if (width <= 0 || text.length <= width) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > width) {
    const whitespace = remaining.lastIndexOf(" ", width);
    const breakAt = whitespace >= Math.ceil(width / 2) ? whitespace : width;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  lines.push(remaining);
  return lines;
};

/** Renders aligned, wrapping tabular data inside the shared Ink CLI layout. */
export function DataTable({
  columns,
  rows,
  accent = palette.primary,
  cellColor,
}: {
  columns: readonly TableColumn[];
  rows: readonly (readonly string[])[];
  accent?: Accent;
  cellColor?: (rowIndex: number, columnIndex: number, value: string) => Accent | undefined;
}) {
  const frameWidth = useContext(LayoutContext);
  const widths = layoutTable({
    columns,
    rows,
    available: Math.max(columns.length, frameWidth - 4),
  });
  const gap = " ".repeat(TABLE_GAP);
  const renderCell = ({ value, columnIndex }: { value: string; columnIndex: number }) => {
    const width = widths[columnIndex] ?? 0;
    return columns[columnIndex]?.align === "right" ? value.padStart(width) : value.padEnd(width);
  };
  const tableWidth =
    widths.reduce((sum, width) => sum + width, 0) + TABLE_GAP * (widths.length - 1);

  return (
    <Box flexDirection="column">
      <Text bold color={accent}>
        {columns
          .map((column, columnIndex) => renderCell({ value: column.header, columnIndex }))
          .join(gap)}
      </Text>
      <Text dimColor>{"─".repeat(Math.max(1, tableWidth))}</Text>
      {rows.map((row, rowIndex) => {
        const wrappedCells = columns.map((_, columnIndex) =>
          wrapTableCell({ value: row[columnIndex] ?? "", width: widths[columnIndex] ?? 0 }),
        );
        const rowHeight = Math.max(...wrappedCells.map((lines) => lines.length));
        return (
          <Box key={rowIndex} flexDirection="column">
            {Array.from({ length: rowHeight }, (_, lineIndex) => (
              <Text key={lineIndex}>
                {columns.map((_, columnIndex) => {
                  const value = row[columnIndex] ?? "";
                  const color = cellColor?.(rowIndex, columnIndex, value);
                  return (
                    <Text key={columnIndex} {...(color === undefined ? {} : { color })}>
                      {renderCell({
                        value: wrappedCells[columnIndex]?.[lineIndex] ?? "",
                        columnIndex,
                      })}
                      {columnIndex === columns.length - 1 ? "" : gap}
                    </Text>
                  );
                })}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

/** Wraps a shared terminal data table in Weldall's standard titled card. */
export function TableCard({
  title,
  columns,
  rows,
  accent = palette.primary,
  cellColor,
}: {
  title: string;
  columns: readonly TableColumn[];
  rows: readonly (readonly string[])[];
  accent?: Accent;
  cellColor?: (rowIndex: number, columnIndex: number, value: string) => Accent | undefined;
}) {
  return (
    <Card title={title} accent={accent}>
      <DataTable
        columns={columns}
        rows={rows}
        accent={accent}
        {...(cellColor === undefined ? {} : { cellColor })}
      />
    </Card>
  );
}

export function FieldList({ fields }: { fields: ReadonlyArray<Field> }) {
  const columns = useContext(LayoutContext);
  const labelWidth = Math.max(0, ...fields.map(([label]) => label.length));
  const stacked = columns < labelWidth + 24;
  return (
    <Box flexDirection="column">
      {fields.map(([label, value]) => (
        <Box key={label} flexDirection={stacked ? "column" : "row"}>
          <Box {...(stacked ? {} : { width: labelWidth + 2, flexShrink: 0 })}>
            <Text dimColor>{label}</Text>
          </Box>
          <Text>{terminalText(value)}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function IdentityCard({
  name,
  email,
  issuer,
  subject,
}: {
  name: string;
  email: string;
  issuer: string;
  subject: string;
}) {
  return (
    <Card title="Account" accent={palette.accent}>
      <Text bold>{terminalText(name)}</Text>
      <Box marginTop={1}>
        <FieldList
          fields={[
            ["Email", email],
            ["Weldall host", issuer],
            ["Account ID", subject],
          ]}
        />
      </Box>
    </Card>
  );
}

export interface AvailableApi {
  id: string;
  name: string;
}

export function PermissionsCard({
  scopes,
  availableApis,
}: {
  scopes: string[];
  availableApis: AvailableApi[];
}) {
  return (
    <Card title="Access" accent={palette.primary}>
      <Text bold>Assigned scopes:</Text>
      <Box flexDirection="column" marginTop={1}>
        {scopes.length === 0 ? (
          <>
            <Text>No scopes are currently assigned to your account.</Text>
            <Text dimColor>Ask your Weldall administrator for the access you need.</Text>
          </>
        ) : (
          scopes.map((scope) => (
            <Text key={scope} color={palette.success}>
              • {terminalText(scope)}
            </Text>
          ))
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>Available APIs:</Text>
        {availableApis.length === 0 ? (
          <Text dimColor>No enabled API resource currently exposes these permissions.</Text>
        ) : (
          availableApis.map((api) => (
            <Text key={api.id} color={palette.accent}>
              • {terminalText(api.name)}
            </Text>
          ))
        )}
      </Box>
    </Card>
  );
}

export interface SkillItem {
  id: string;
  title: string;
  available: boolean;
  missingScopes: string[];
}

export function SkillsCard({ skills }: { skills: SkillItem[] }) {
  return (
    <Card title="Skills" accent={palette.accent}>
      {skills.map((skill, index) => (
        <Box
          key={skill.id}
          flexDirection="column"
          marginBottom={index === skills.length - 1 ? 0 : 1}
        >
          <Text bold color={skill.available ? palette.success : palette.warning}>
            {skill.available ? "✓" : "!"} {terminalText(skill.title)}
          </Text>
          <Text dimColor>ID: {terminalText(skill.id)}</Text>
          {!skill.available && (
            <Text color={palette.warning}>
              Not available
              {skill.missingScopes.length > 0
                ? ` · missing ${skill.missingScopes.map(terminalText).join(", ")}`
                : ""}
            </Text>
          )}
        </Box>
      ))}
    </Card>
  );
}

const noticeStyle: Record<NoticeKind, { accent: Accent; glyph: string; label: string }> = {
  success: { accent: palette.success, glyph: "✓", label: "Success" },
  info: { accent: palette.primary, glyph: "●", label: "Info" },
  warning: { accent: palette.warning, glyph: "!", label: "Warning" },
  error: { accent: palette.danger, glyph: "×", label: "Error" },
};

export function Notice({
  kind,
  message,
  hint,
}: {
  kind: NoticeKind;
  message: string;
  hint?: string;
}) {
  const style = noticeStyle[kind];
  return (
    <Box borderStyle="round" borderColor={style.accent} flexDirection="column" paddingX={1}>
      <Text>
        <Text bold color={style.accent}>
          {style.glyph} {style.label}
        </Text>
        {`  ${terminalDocument(message)}`}
      </Text>
      {hint && (
        <Text>
          <Text dimColor>Hint:</Text> {terminalText(hint)}
        </Text>
      )}
    </Box>
  );
}

/** Writes a styled notice to the correct stream while preserving redirect-safe output. */
const printNotice = ({
  kind,
  message,
  hint,
  stream = kind === "error" ? "stderr" : "stdout",
}: {
  kind: NoticeKind;
  message: string;
  hint?: string | undefined;
  stream?: "stdout" | "stderr" | undefined;
}) => {
  const longestMessageLine = Math.max(
    ...terminalDocument(message)
      .split("\n")
      .map((line) => line.length),
  );
  const contentWidth = Math.max(longestMessageLine + 16, hint ? hint.length + 10 : 0);
  const output = renderUi({
    node: <Notice kind={kind} message={message} {...(hint === undefined ? {} : { hint })} />,
    columns: Math.min(terminalColumns(stream), contentWidth),
    stream,
  });
  if (stream === "stderr") console.error(output);
  else console.log(output);
};

export const success = (message: string) => printNotice({ kind: "success", message });
export const info = (message: string) => printNotice({ kind: "info", message });
export const warning = ({ message, hint }: { message: string; hint?: string | undefined }) =>
  printNotice({ kind: "warning", message, hint });
export const printWarning = ({ message, hint }: { message: string; hint?: string | undefined }) =>
  printNotice({ kind: "warning", message, hint, stream: "stderr" });
export const printError = ({ message, hint }: { message: string; hint?: string | undefined }) =>
  printNotice({ kind: "error", message, hint });

export const printFields = ({
  fields,
  title = "Details",
}: {
  fields: ReadonlyArray<Field>;
  title?: string;
}) =>
  printUi(
    <Card title={title} accent={palette.accent}>
      <FieldList fields={fields} />
    </Card>,
  );

export interface HeaderIdentity {
  name: string;
  email: string;
}

export interface HeaderSkill {
  slug: string;
  title: string;
  available: boolean;
}

export interface HeaderConnector {
  key: string;
  name: string;
  groups: string[];
}

export interface HeaderConnection {
  name: string;
  connectorKey: string;
  status: string;
}

const PREVIEW_LIMIT = 5;

export function WeldallCard({
  issuer,
  identity,
  fill = false,
}: {
  issuer: string | null;
  identity: HeaderIdentity | null;
  fill?: boolean;
}) {
  return (
    <Card title="Weldall" accent={palette.brand} fill={fill}>
      <FieldList
        fields={
          identity
            ? [
                ["Host", issuer ?? "Not configured"],
                ["Name", identity.name],
                ["Email", identity.email],
              ]
            : [
                ["Host", issuer ?? "Not configured"],
                ["Account", "Not signed in"],
              ]
        }
      />
    </Card>
  );
}

function ScopePreview({ scopes }: { scopes: string[] }) {
  const visible = scopes.slice(0, PREVIEW_LIMIT);
  return (
    <Card title="Scopes" accent={palette.primary}>
      {visible.length > 0 ? (
        visible.map((scope) => <Text key={scope}>• {terminalText(scope)}</Text>)
      ) : (
        <Text dimColor>No cached scopes.</Text>
      )}
      {scopes.length > visible.length && (
        <Text dimColor>… {scopes.length - visible.length} more</Text>
      )}
      <Box marginTop={1}>
        <Text dimColor>Run `weldall scopes` to view the complete list.</Text>
      </Box>
    </Card>
  );
}

function ConnectorPreview({
  connectors,
  connections,
}: {
  connectors: HeaderConnector[];
  connections: HeaderConnection[];
}) {
  const visible = connectors.slice(0, PREVIEW_LIMIT);
  const visibleKeys = new Set(visible.map((connector) => connector.key));
  const visibleConnections = connections.filter(
    (connection) =>
      visibleKeys.has(connection.connectorKey) && connection.status !== "DISCONNECTED",
  );
  const firstReady = visibleConnections.find((connection) => connection.status === "READY");
  const readyRequest = firstReady
    ? `weldall request --connection ${terminalText(firstReady.name)} <provider-https-url>`
    : null;
  return (
    <Card title="Connectors & connections" accent={palette.success}>
      {visible.length > 0 ? (
        visible.map((connector) => {
          const connectorConnections = visibleConnections.filter(
            (connection) => connection.connectorKey === connector.key,
          );
          return (
            <Box key={connector.key} flexDirection="column">
              <Text>
                • {terminalText(connector.name)} ({terminalText(connector.key)})
                {connector.groups.length > 0
                  ? ` — ${connector.groups.map(terminalText).join(", ")}`
                  : ""}
              </Text>
              {connectorConnections.map((connection) =>
                connection.status === "READY" ? (
                  <Text key={connection.name} color={palette.success}>
                    {"  "}✓ {terminalText(connection.name)} is ready for{" "}
                    {terminalText(connector.name)} requests.
                  </Text>
                ) : (
                  <Text key={connection.name} color={palette.warning}>
                    {"  "}! {terminalText(connection.name)} · {terminalText(connection.status)}
                  </Text>
                ),
              )}
            </Box>
          );
        })
      ) : (
        <Text dimColor>No cached connectors or connections.</Text>
      )}
      {connectors.length > visible.length && (
        <Text dimColor>… {connectors.length - visible.length} more</Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text>Run `weldall connectors --agentic` for the complete permission catalog.</Text>
        {readyRequest ? (
          <Text>Request now: `{readyRequest}`.</Text>
        ) : (
          <Text>Connect with `weldall connections connect &lt;key&gt; --name &lt;name&gt;`.</Text>
        )}
      </Box>
    </Card>
  );
}

function SkillPreview({ skills }: { skills: HeaderSkill[] }) {
  return (
    <Card title="Skills" accent={palette.accent}>
      <Text>
        Find organizational capabilities with:
        {"\n"} weldall skills find &lt;keyword&gt;
      </Text>
      <Box marginTop={1}>
        <Text dimColor>
          {skills.length > 0
            ? `${skills.length} cached skill${skills.length === 1 ? "" : "s"}. `
            : "No cached skills. "}
          Run `weldall skills list` for the complete list.
        </Text>
      </Box>
    </Card>
  );
}

export function HelpHeader({
  issuer,
  identity,
  appendix,
  scopes,
  skills,
  connectors,
  connections,
}: {
  issuer: string | null;
  identity: HeaderIdentity | null;
  appendix: string;
  scopes: string[];
  skills: HeaderSkill[];
  connectors: HeaderConnector[];
  connections: HeaderConnection[];
}) {
  const instructions = terminalDocument(appendix).trim();
  return (
    <Box flexDirection="column" gap={1}>
      <WeldallCard issuer={issuer} identity={identity} />
      <Card title="Organization instructions" accent={palette.warning}>
        <Text>{instructions || "No organization instructions configured."}</Text>
      </Card>
      <ScopePreview scopes={scopes} />
      <ConnectorPreview connectors={connectors} connections={connections} />
      <SkillPreview skills={skills} />
    </Box>
  );
}

export const brandHeading = ({
  issuer,
  identity = null,
}: {
  issuer: string | null;
  identity?: HeaderIdentity | null;
}) => {
  const longestValue = Math.max(
    issuer?.length ?? "Not configured".length,
    identity?.name.length ?? "Not signed in".length,
    identity?.email.length ?? 0,
  );
  return renderUi({
    node: <WeldallCard issuer={issuer} identity={identity} />,
    columns: Math.min(terminalColumns(), Math.max(28, longestValue + 12)),
  });
};

export const helpHeader = ({
  issuer,
  identity,
  appendix,
  scopes = [],
  skills = [],
  connectors = [],
  connections = [],
  columns = terminalColumns(),
}: {
  issuer: string | null;
  identity: HeaderIdentity | null;
  appendix: string;
  scopes?: string[];
  skills?: HeaderSkill[];
  connectors?: HeaderConnector[];
  connections?: HeaderConnection[];
  columns?: number;
}) =>
  renderUi({
    node: (
      <HelpHeader
        issuer={issuer}
        identity={identity}
        appendix={appendix}
        scopes={scopes}
        skills={skills}
        connectors={connectors}
        connections={connections}
      />
    ),
    columns,
  });

export const appendixFrame = ({
  value,
  columns = terminalColumns(),
}: {
  value: string;
  columns?: number;
}) => {
  const document = terminalDocument(value).trim();
  if (!document) return "";
  return renderUi({
    node: (
      <Card title="Organization instructions" accent={palette.warning}>
        <Text>{document}</Text>
      </Card>
    ),
    columns,
  });
};
