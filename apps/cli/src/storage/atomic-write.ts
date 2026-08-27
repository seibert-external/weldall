import { randomUUID } from "node:crypto";
import { rm, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteFileOptions {
  /** Path of the temporary file to write then rename over `destination`. */
  temporary?: string;
  /** Total rename attempts when the failure is EPERM (initial attempt plus retries). Default 5. */
  attempts?: number;
  /** Initial EPERM-retry backoff in milliseconds; doubles per retry. Default 50. */
  baseDelayMs?: number;
  /** Cap for the EPERM-retry backoff in milliseconds. Default 400. */
  maxDelayMs?: number;
  /** Injected temporary-file writer (test seam); defaults to fs/promises `writeFile`. */
  writeFile?: (path: string, value: string, options: { flag: "wx"; mode: number }) => Promise<void>;
  /** Injected rename (test seam); defaults to fs/promises `rename`. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Injected cleanup (test seam); defaults to fs/promises `rm`. */
  rm?: (path: string, options: { force: true }) => Promise<void>;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const isEpermError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EPERM";

/**
 * Atomically replace `destination` with `value` via an exclusive sibling temporary
 * file, keeping the existing atomicity contract: the temporary file is written with
 * flag `"wx"` and mode 0o600, then renamed over the destination, with best-effort
 * temporary cleanup that never hides the original write or replacement error.
 *
 * Renaming over a file that another process currently has open fails with EPERM on
 * Windows (MoveFileExW + MOVEFILE_REPLACE_EXISTING denies a destination whose open
 * handles did not request FILE_SHARE_DELETE), so the rename is retried with a small
 * bounded backoff to let a momentary concurrent reader's handle close. Non-EPERM
 * failures abort immediately and the original error is preserved on final failure.
 */
export async function atomicWriteFile(
  destination: string,
  value: string,
  options: AtomicWriteFileOptions = {},
): Promise<void> {
  const temporary =
    options.temporary ??
    join(dirname(destination), `.${basename(destination)}-${randomUUID()}.tmp`);
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 400;
  const writeTemporary = options.writeFile ?? writeFile;
  const renameFile = options.rename ?? rename;
  const removeFile = options.rm ?? rm;
  try {
    await writeTemporary(temporary, value, { flag: "wx", mode: 0o600 });
    for (let attempt = 1; ; attempt++) {
      try {
        await renameFile(temporary, destination);
        return;
      } catch (error) {
        if (!isEpermError(error) || attempt >= attempts) throw error;
        await sleep(Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs));
      }
    }
  } finally {
    try {
      await removeFile(temporary, { force: true });
    } catch {
      // Best-effort cleanup must not hide the original write or replacement error.
    }
  }
}
