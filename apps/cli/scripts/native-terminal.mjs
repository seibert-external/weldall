import assert from "node:assert/strict";
import { spawn as spawnPty } from "@lydell/node-pty";

const environmentStrings = (environment) =>
  Object.fromEntries(
    Object.entries(environment)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name, String(value)]),
  );

export function terminalLauncher(
  command,
  prefix = [],
  {
    baseEnvironment = process.env,
    timeoutMs = 30_000,
    spawn = spawnPty,
    platform = process.platform,
  } = {},
) {
  return (args, options) => {
    const terminal = spawn(command, [...prefix, ...args], {
      cwd: options.cwd,
      env: environmentStrings({ ...baseEnvironment, ...options.env }),
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      useConpty: true,
    });
    let output = "";
    let exited = false;
    let timedOut = false;
    const dataSubscription = terminal.onData((value) => {
      output += value;
    });
    let timer;
    const result = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        terminal.kill();
      }, timeoutMs);
      const exitSubscription = terminal.onExit(({ exitCode, signal }) => {
        exited = true;
        clearTimeout(timer);
        dataSubscription.dispose();
        exitSubscription.dispose();
        // node-pty can leave the ConPTY host pipe referenced after the child has
        // exited, which keeps the smoke process alive indefinitely. kill() also
        // closes that native terminal resource and is safe after the exit event.
        if (platform === "win32") terminal.kill();
        resolve({
          status: signal ? 128 + signal : exitCode,
          signal: signal || null,
          stdout: output,
          stderr: timedOut ? `Terminal process exceeded ${timeoutMs}ms timeout` : "",
          exited: true,
        });
      });
    });
    result.write = (value) => {
      if (exited) return false;
      terminal.write(value);
      return true;
    };
    result.waitForOutput = (pattern, waitMs = 10_000) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + waitMs;
        const poll = () => {
          if (pattern.test(output)) return resolve();
          if (exited) return reject(new Error(`Terminal exited before emitting ${pattern}`));
          if (Date.now() >= deadline)
            return reject(new Error(`Timed out waiting for terminal output ${pattern}`));
          setTimeout(poll, 20);
        };
        poll();
      });
    result.interrupt = () => result.write("\x03");
    result.cancel = async () => {
      if (!exited) terminal.kill();
      return result;
    };
    return result;
  };
}

// ConPTY emits terminal-management SGR resets even when the child has color disabled.
// Match an actual ANSI foreground color so the assertion measures the CLI's output.
const colorSequence = /\u001B\[(?:3[0-7]|9[0-7])m/;

export async function smokeNativeTerminal({ launch, cwd, label }) {
  const commonEnvironment = {
    NODE_ENV: "production",
    TERM: "xterm-256color",
    WELDALL_ISSUER: "https://terminal-smoke.example.com",
  };
  const colored = await launch(["config", "get-issuer"], {
    cwd,
    env: { ...commonEnvironment, NO_COLOR: undefined },
  });
  assert.equal(
    colored.status,
    0,
    `${label} colored TTY failed:\n${colored.stdout}\n${colored.stderr}`,
  );
  assert.match(colored.stdout, /Configuration/);
  assert.match(colored.stdout, /terminal-smoke\.example\.com/);
  assert.match(colored.stdout, /╭|╰/u, `${label} did not render the Ink terminal panel`);
  assert.match(colored.stdout, colorSequence, `${label} did not emit terminal color`);

  const plain = await launch(["config", "get-issuer"], {
    cwd,
    env: { ...commonEnvironment, NO_COLOR: "1" },
  });
  assert.equal(plain.status, 0, `${label} NO_COLOR TTY failed:\n${plain.stdout}\n${plain.stderr}`);
  assert.match(plain.stdout, /Configuration/);
  assert.match(plain.stdout, /terminal-smoke\.example\.com/);
  assert.match(plain.stdout, /╭|╰/u, `${label} did not retain human TTY rendering`);
  assert.doesNotMatch(plain.stdout, colorSequence, `${label} ignored NO_COLOR`);
  console.log(`${label} native TTY color and NO_COLOR smoke passed`);
}
