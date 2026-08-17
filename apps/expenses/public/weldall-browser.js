import {
  createWeldallBrowserClient,
  inspectWeldallBrowserSupport,
  WeldallBrowserError,
} from "/weldall-browser/sdk/index.js";

const $ = (id) => document.getElementById(id);
const output = $("output");
const command = $("command");
const identity = $("identity");
let client;
let apiEndpoint;

function show(kind, value) {
  output.dataset.kind = kind;
  output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function showError(error) {
  if (error instanceof WeldallBrowserError) {
    show("error", `${error.code}: ${error.message}\n${error.recovery}`);
  } else {
    show("error", error instanceof Error ? error.message : String(error));
  }
}

async function guarded(operation) {
  try {
    await operation();
  } catch (error) {
    showError(error);
  }
}

async function status(verify) {
  const value = await client.getConnectionStatus({ verify });
  identity.textContent =
    value.state === "connected" && value.subject ? value.subject : "Not connected";
  show("success", value);
}

async function initialize() {
  const support = await inspectWeldallBrowserSupport();
  $("support").textContent = support.supported
    ? "Supported browser"
    : `Unsupported browser: ${support.missingFeatures.join(", ")}`;
  if (!support.supported) {
    show("error", "This browser cannot persist the required non-exportable Weldall key.");
    for (const button of document.querySelectorAll("button")) button.disabled = true;
    return;
  }
  const response = await fetch("/weldall-browser/config", {
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) throw new Error("Development browser configuration is unavailable");
  const config = await response.json();
  client = await createWeldallBrowserClient({ issuer: config.issuer, resource: config.resource });
  apiEndpoint = config.apiEndpoint;
  await status("local");
}

$("connect").addEventListener(
  "click",
  () =>
    void guarded(async () => {
      const pending = await client.connect({ method: "cli-code" });
      command.textContent = `weldall connect ${pending.userCode}`;
      show("pending", { command: command.textContent, expiresAt: pending.expiresAt });
      void pending.connected
        .then((value) => {
          command.textContent = "";
          identity.textContent = value.subject ?? "Connected";
          show("success", value);
        })
        .catch(showError);
    }),
);
$("local-status").addEventListener("click", () => void guarded(() => status("local")));
$("remote-status").addEventListener("click", () => void guarded(() => status("remote")));
$("read").addEventListener(
  "click",
  () =>
    void guarded(async () => {
      const response = await client.request(apiEndpoint, {
        scopes: ["expenses:read"],
      });
      show(response.ok ? "success" : "error", await response.json());
    }),
);
$("create").addEventListener(
  "click",
  () =>
    void guarded(async () => {
      const response = await client.request(apiEndpoint, {
        method: "POST",
        scopes: ["expenses:create"],
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "Browser development expense", amount: 24 }),
      });
      show(response.ok ? "success" : "error", await response.json());
    }),
);
$("disconnect").addEventListener(
  "click",
  () =>
    void guarded(async () => {
      await client.disconnect();
      command.textContent = "";
      await status("local");
    }),
);
$("clear").addEventListener(
  "click",
  () =>
    void guarded(async () => {
      await client.clearLocalConnection();
      command.textContent = "";
      await status("local");
    }),
);
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  showError(event.reason);
});
void guarded(initialize);
