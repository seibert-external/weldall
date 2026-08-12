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

type Accent = (typeof palette)[keyof typeof palette];
type NoticeKind = "success" | "info" | "warning" | "error";
type OutputStream = "stdout" | "stderr";
type Field = readonly [label: string, value: string];

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

export const renderUi = (
  node: ReactNode,
  columns = terminalColumns(),
  stream: OutputStream = "stdout",
) => {
  const width = frameColumns(columns);
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

export const printUi = (node: ReactNode) => console.log(renderUi(node));

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

export interface PermissionItem {
  description: string;
  scope: string;
}

export interface AvailableApi {
  id: string;
  name: string;
}

export function PermissionsCard({
  permissions,
  availableApis,
}: {
  permissions: PermissionItem[];
  availableApis: AvailableApi[];
}) {
  return (
    <Card title="Access" accent={palette.primary}>
      <Text bold>Assigned permissions:</Text>
      <Box flexDirection="column" marginTop={1}>
        {permissions.length === 0 ? (
          <>
            <Text>No permissions are currently assigned to your account.</Text>
            <Text dimColor>Ask your Weldall administrator for the access you need.</Text>
          </>
        ) : (
          permissions.map(({ description, scope }) => (
            <Box key={scope}>
              <Box width={2} flexShrink={0}>
                <Text color={palette.success}>✓</Text>
              </Box>
              <Box flexDirection="column">
                <Text>{terminalText(description)}</Text>
                <Text dimColor>{terminalText(scope)}</Text>
              </Box>
            </Box>
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

const printNotice = (
  kind: NoticeKind,
  message: string,
  hint?: string,
  stream: "stdout" | "stderr" = kind === "error" ? "stderr" : "stdout",
) => {
  const longestMessageLine = Math.max(
    ...terminalDocument(message)
      .split("\n")
      .map((line) => line.length),
  );
  const contentWidth = Math.max(longestMessageLine + 16, hint ? hint.length + 10 : 0);
  const output = renderUi(
    <Notice kind={kind} message={message} {...(hint === undefined ? {} : { hint })} />,
    Math.min(terminalColumns(stream), contentWidth),
    stream,
  );
  if (stream === "stderr") console.error(output);
  else console.log(output);
};

export const success = (message: string) => printNotice("success", message);
export const info = (message: string) => printNotice("info", message);
export const warning = (message: string, hint?: string) => printNotice("warning", message, hint);
export const printWarning = (message: string, hint?: string) =>
  printNotice("warning", message, hint, "stderr");
export const printError = (message: string, hint?: string) => printNotice("error", message, hint);

export const printFields = (fields: ReadonlyArray<Field>, title = "Details") =>
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

function SkillPreview({ skills }: { skills: HeaderSkill[] }) {
  const visible = skills.slice(0, PREVIEW_LIMIT);
  return (
    <Card title="Skills" accent={palette.accent}>
      {visible.length > 0 ? (
        visible.map((skill) => (
          <Text key={skill.slug}>
            <Text color={skill.available ? palette.success : palette.warning}>
              {skill.available ? "✓" : "!"}
            </Text>{" "}
            {terminalText(skill.title)} <Text dimColor>({terminalText(skill.slug)})</Text>
          </Text>
        ))
      ) : (
        <Text dimColor>No cached skills.</Text>
      )}
      {skills.length > visible.length && (
        <Text dimColor>… {skills.length - visible.length} more</Text>
      )}
      <Box marginTop={1}>
        <Text dimColor>Run `weldall skills` to view the complete list.</Text>
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
}: {
  issuer: string | null;
  identity: HeaderIdentity | null;
  appendix: string;
  scopes: string[];
  skills: HeaderSkill[];
}) {
  const instructions = terminalDocument(appendix).trim();
  return (
    <Box flexDirection="column" gap={1}>
      <WeldallCard issuer={issuer} identity={identity} />
      <Card title="Organization instructions" accent={palette.warning}>
        <Text>{instructions || "No organization instructions configured."}</Text>
      </Card>
      <ScopePreview scopes={scopes} />
      <SkillPreview skills={skills} />
    </Box>
  );
}

export const brandHeading = (issuer: string | null, identity: HeaderIdentity | null = null) => {
  const longestValue = Math.max(
    issuer?.length ?? "Not configured".length,
    identity?.name.length ?? "Not signed in".length,
    identity?.email.length ?? 0,
  );
  return renderUi(
    <WeldallCard issuer={issuer} identity={identity} />,
    Math.min(terminalColumns(), Math.max(28, longestValue + 12)),
  );
};

export const helpHeader = (
  issuer: string | null,
  identity: HeaderIdentity | null,
  appendix: string,
  scopes: string[] = [],
  skills: HeaderSkill[] = [],
  columns = terminalColumns(),
) =>
  renderUi(
    <HelpHeader
      issuer={issuer}
      identity={identity}
      appendix={appendix}
      scopes={scopes}
      skills={skills}
    />,
    columns,
  );

export const appendixFrame = (value: string, columns = terminalColumns()) => {
  const document = terminalDocument(value).trim();
  if (!document) return "";
  return renderUi(
    <Card title="Organization instructions" accent={palette.warning}>
      <Text>{document}</Text>
    </Card>,
    columns,
  );
};
