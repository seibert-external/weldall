export type ConnectorCallbackPage =
  | {
      kind: "success";
      connectionName: string;
      accountDisplayName: string;
    }
  | { kind: "cancelled" }
  | { kind: "invalid" }
  | { kind: "failure" };

const copy = {
  success: {
    title: "Google connected",
    eyebrow: "Connection complete",
    summary: "Your Google account is ready to use through Weldall.",
    action: "Close this window and return to the CLI.",
    symbol: "✓",
  },
  cancelled: {
    title: "Connection cancelled",
    eyebrow: "Authorization cancelled",
    summary: "Google authorization was declined, so no connection was completed.",
    action: "Close this window, then return to the CLI to try again when you are ready.",
    symbol: "×",
  },
  invalid: {
    title: "Invalid authorization response",
    eyebrow: "Connection failed",
    summary: "Weldall could not verify the authorization response from Google.",
    action: "Close this window, return to the CLI, and retry the connection.",
    symbol: "!",
  },
  failure: {
    title: "Connection could not be completed",
    eyebrow: "Connection failed",
    summary: "Weldall received the authorization response but could not finish the connection.",
    action: "Close this window, return to the CLI, and retry the connection.",
    symbol: "!",
  },
} as const;

export function connectorCallbackPage(result: ConnectorCallbackPage): Response {
  const content = copy[result.kind];
  const successDetails =
    result.kind === "success"
      ? `<dl class="details"><div><dt>Connection</dt><dd>${escapeHtml(result.connectionName)}</dd></div><div><dt>Google account</dt><dd>${escapeHtml(result.accountDisplayName)}</dd></div></dl>`
      : "";
  const status = result.kind === "success" ? 200 : 400;

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(content.title)} · Weldall</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --ink: #15231f; --muted: #5d6d67; --surface: rgba(255,255,255,.92); --line: rgba(21,35,31,.12); --brand: #075e54; --brand-soft: #dff4ed; --danger: #9d2d3f; --danger-soft: #fde8ec; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; color: var(--ink); background: radial-gradient(circle at 20% 10%, rgba(28,160,135,.19), transparent 38rem), radial-gradient(circle at 90% 90%, rgba(68,77,196,.14), transparent 34rem), #f4f7f6; display: grid; place-items: center; padding: 24px; }
    main { width: min(100%, 620px); }
    .brand { display: flex; align-items: center; gap: 10px; margin: 0 0 18px 4px; color: var(--brand); font-size: 14px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    .brand-mark { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; color: white; background: linear-gradient(135deg, #08776a, #393d9f); box-shadow: 0 8px 22px rgba(7,94,84,.22); }
    .card { overflow: hidden; border: 1px solid var(--line); border-radius: 24px; background: var(--surface); box-shadow: 0 24px 70px rgba(31,52,46,.14); backdrop-filter: blur(18px); }
    .accent { height: 6px; background: linear-gradient(90deg, #08776a, #3b3e9f); }
    .content { padding: clamp(28px, 7vw, 52px); }
    .status-icon { width: 64px; height: 64px; border-radius: 20px; display: grid; place-items: center; margin-bottom: 24px; font-size: 34px; font-weight: 800; color: var(--brand); background: var(--brand-soft); }
    [data-kind="cancelled"] .status-icon, [data-kind="invalid"] .status-icon, [data-kind="failure"] .status-icon { color: var(--danger); background: var(--danger-soft); }
    .eyebrow { margin: 0 0 8px; color: var(--brand); font-size: 13px; font-weight: 750; letter-spacing: .09em; text-transform: uppercase; }
    [data-kind="cancelled"] .eyebrow, [data-kind="invalid"] .eyebrow, [data-kind="failure"] .eyebrow { color: var(--danger); }
    h1 { margin: 0; font-size: clamp(30px, 7vw, 44px); line-height: 1.08; letter-spacing: -.035em; }
    .summary { margin: 18px 0 0; color: var(--muted); font-size: 17px; line-height: 1.6; }
    .details { display: grid; gap: 1px; margin: 28px 0 0; overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--line); }
    .details div { min-width: 0; padding: 15px 17px; background: var(--surface); }
    dt { margin-bottom: 5px; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    dd { margin: 0; overflow-wrap: anywhere; font-size: 15px; font-weight: 650; }
    .action { display: flex; gap: 12px; align-items: flex-start; margin: 28px 0 0; padding: 17px 18px; border-radius: 14px; color: #fff; background: var(--brand); font-weight: 700; line-height: 1.45; box-shadow: 0 10px 28px rgba(7,94,84,.2); }
    [data-kind="cancelled"] .action, [data-kind="invalid"] .action, [data-kind="failure"] .action { background: #6d2734; box-shadow: 0 10px 28px rgba(109,39,52,.16); }
    .action span:first-child { font-size: 20px; line-height: 1; }
    .security { margin: 18px 4px 0; color: var(--muted); font-size: 12px; line-height: 1.5; text-align: center; }
    @media (max-width: 480px) { body { align-items: start; padding: 18px; } main { margin-top: 7vh; } .card { border-radius: 19px; } .content { padding: 28px 24px; } }
    @media (prefers-reduced-motion: no-preference) { .card { animation: arrive .35s ease-out both; } @keyframes arrive { from { opacity: 0; transform: translateY(8px); } } }
    @media (prefers-color-scheme: dark) { :root { --ink: #edf7f3; --muted: #a9bbb4; --surface: rgba(17,28,25,.94); --line: rgba(222,244,236,.14); --brand: #72d5c0; --brand-soft: #153c34; --danger: #ff9bab; --danger-soft: #48232a; } body { background: radial-gradient(circle at 20% 10%, rgba(20,124,106,.26), transparent 38rem), radial-gradient(circle at 90% 90%, rgba(64,68,168,.22), transparent 34rem), #0c1211; } .action { color: #fff; background: #076b5f; } }
  </style>
</head>
<body>
  <main data-kind="${result.kind}">
    <div class="brand"><span class="brand-mark" aria-hidden="true">W</span><span>Weldall</span></div>
    <section class="card" aria-labelledby="result-title">
      <div class="accent"></div>
      <div class="content">
        <div class="status-icon" aria-hidden="true">${content.symbol}</div>
        <p class="eyebrow">${content.eyebrow}</p>
        <h1 id="result-title">${content.title}</h1>
        <p class="summary">${content.summary}</p>
        ${successDetails}
        <p class="action"><span aria-hidden="true">→</span><span>${content.action}</span></p>
      </div>
    </section>
    <p class="security">This result was returned directly by your Weldall server.</p>
  </main>
</body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}
