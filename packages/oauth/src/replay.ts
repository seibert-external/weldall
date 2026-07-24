import { OAuthError } from "./errors.js";
export class ReplayStore {
  private readonly values = new Map<string, number>();
  constructor(
    private readonly maxEntries = 10_000,
    private readonly replayError = {
      code: "invalid_dpop_proof",
      message: "proof was already used",
    },
  ) {}
  consume(key: string, expiresAt: number, now = Date.now()): void {
    this.prune(now);
    if (this.values.has(key)) throw new OAuthError(this.replayError.code, this.replayError.message);
    if (this.values.size >= this.maxEntries)
      throw new OAuthError("temporarily_unavailable", "replay store capacity reached", 503);
    this.values.set(key, expiresAt);
  }
  private prune(now: number): void {
    for (const [key, expiry] of this.values) if (expiry <= now) this.values.delete(key);
  }
  get size(): number {
    this.prune(Date.now());
    return this.values.size;
  }
}
