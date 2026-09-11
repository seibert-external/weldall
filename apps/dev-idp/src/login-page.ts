import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const readPackageFile = (id: string) => readFileSync(require.resolve(id), "utf8");

/**
 * The Astryx layers apps/weldall loads (see the @import list in apps/weldall/src/app/styles.css):
 * base reset and the neutral theme. The component stylesheet is 123 kB of pre-compiled StyleX
 * classes this page cannot use, so only its `:root` token declarations are taken from it.
 */
const astryxTokens = readPackageFile("@astryxdesign/core/astryx.css")
  .split("\n")
  .filter((line) => /^\s*:root[^{}]*\{--[^{}]*\}\s*$/.test(line))
  .join("\n");
if (!astryxTokens) throw new Error("@astryxdesign/core no longer declares :root tokens");
const astryxStyles = [
  readPackageFile("@astryxdesign/core/reset.css"),
  astryxTokens,
  readPackageFile("@astryxdesign/theme-neutral/theme.css"),
].join("\n");

/** Token overrides copied from apps/weldall/src/app/styles.css: square corners, #ebebeb borders. */
const weldallTokens = `
:root, [data-theme], [data-astryx-theme] {
  --color-border: light-dark(#ebebeb, #ffffff1a);
  --color-border-emphasized: light-dark(#ebebeb, #525252);
  --radius-inner: 0;
  --radius-element: 0;
  --radius-container: 0;
  --radius-page: 0;
  --radius-chat: 0;
  --radius-full: 0;
}
`;

/**
 * Page rules. The shell and panel are copied from apps/weldall/src/app/styles.css; the controls
 * follow the Astryx components the app renders (`Field/inputStyles.stylex.ts`, `FieldLabel.tsx`,
 * `Button.tsx`, `FieldStatus.tsx`) through the same tokens.
 */
const pageStyles = `
:root { color-scheme: light dark; }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }

body {
  background: var(--color-background-body);
  color: var(--color-text-primary);
  font-family: var(--font-family-body);
  font-size: var(--text-body-size);
  line-height: var(--text-body-leading);
}

.login-shell {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding: 1.5rem;
}

.login-panel {
  width: min(28rem, 100%);
  border: 1px solid var(--color-border);
  background: var(--color-background-surface);
  padding: 1.5rem;
}

.login-lede {
  color: var(--color-text-secondary);
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3);
  margin-top: var(--spacing-5);
}

.login-field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-1);
}

.login-field label {
  color: var(--color-text-secondary);
  font-size: var(--text-label-size);
  font-weight: var(--font-weight-medium);
  line-height: var(--text-label-leading);
  cursor: pointer;
}

.login-field input {
  height: var(--size-element-md);
  padding-block: var(--spacing-1);
  padding-inline: var(--spacing-2);
  border: var(--border-width) solid var(--color-border-emphasized);
  border-radius: var(--radius-element);
  background: var(--color-background-surface);
  color: var(--color-text-primary);
  font-family: var(--font-family-body);
  font-size: var(--text-body-size);
  line-height: var(--text-body-leading);
  transition: border-color, box-shadow var(--duration-fast) var(--ease-standard);
}

.login-field input:hover:not(:focus) {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--color-border-emphasized) 30%, transparent);
}

.login-field input:focus {
  border-color: var(--color-accent);
  box-shadow: inset 0 0 0 2px var(--color-accent-muted);
  outline: none;
}

.login-field input[aria-invalid="true"] {
  border-color: var(--color-error);
}

.login-form button {
  height: var(--size-element-md);
  padding-inline: var(--spacing-3);
  border: 0;
  border-radius: var(--radius-element);
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-family: var(--font-family-body);
  font-size: var(--text-label-size);
  font-weight: var(--font-weight-medium);
  line-height: var(--text-label-leading);
  cursor: pointer;
  transition: background-image, background-color, color, opacity, transform var(--duration-fast) var(--ease-standard);
}

.login-form button:hover {
  background-image: linear-gradient(var(--color-overlay-hover), var(--color-overlay-hover));
}

.login-form button:active {
  background-image: linear-gradient(var(--color-overlay-pressed), var(--color-overlay-pressed));
}

.login-form button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 3px;
}

.login-error {
  padding: var(--spacing-2);
  border-radius: var(--radius-element);
  background: var(--color-error-muted);
  color: var(--color-text-red);
  font-size: var(--text-supporting-size);
  line-height: var(--text-supporting-leading);
}

.login-note {
  margin-top: var(--spacing-5);
  padding-top: var(--spacing-4);
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: var(--text-supporting-size);
  line-height: var(--text-supporting-leading);
}
`;

const styles = [astryxStyles, weldallTokens, pageStyles].join("\n");

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escaped[character]!;
  });

/** The inline style block is the only allowed style source; the hash covers exactly `styles`. */
export const loginPageHeaders = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "content-security-policy": `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'sha256-${createHash("sha256").update(styles).digest("base64")}'`,
  "x-content-type-options": "nosniff",
};

/**
 * Renders the passwordless development login form in the Weldall/Astryx neutral theme.
 * `suggestions` are the configured identities, offered through a datalist; the input itself
 * accepts any email address. `value` is the current field content and `mode` mirrors the Weldall
 * theme cookie when one is set.
 */
export function loginPage(input: {
  transaction: string;
  suggestions: string[];
  value?: string;
  error?: string;
  mode?: "light" | "dark" | undefined;
}) {
  const suggestions = input.suggestions
    .map((email) => `<option value="${escapeHtml(email)}"></option>`)
    .join("");
  const error = input.error
    ? `<p class="login-error" id="email-error" role="alert">${escapeHtml(input.error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en" data-astryx-theme="neutral"${input.mode ? ` data-theme="${input.mode}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Development login</title>
<style>${styles}</style>
</head>
<body>
<main class="login-shell">
<section class="login-panel" aria-labelledby="login-heading">
<h1 id="login-heading">Development login</h1>
<p class="login-lede">Sign in with any email address. No password is required.</p>
<form class="login-form" method="post" action="/login">
<input type="hidden" name="transaction" value="${escapeHtml(input.transaction)}">
<div class="login-field">
<label for="email">Email</label>
<input id="email" name="email" type="email" list="known-emails" placeholder="you@example.com" autocomplete="email" spellcheck="false" required autofocus${input.error ? ' aria-invalid="true" aria-describedby="email-error"' : ""} value="${escapeHtml(input.value ?? "")}">
<datalist id="known-emails">${suggestions}</datalist>
${error}
</div>
<button type="submit">Continue</button>
</form>
<p class="login-note">Insecure development fixture: it issues a verified identity for any address it is given, so never expose it to an untrusted network. Configured identities are suggested as you type.</p>
</section>
</main>
</body>
</html>`;
}
