import type { JWTPayload } from "jose";

export type VerifiedEmailClaims = JWTPayload & {
  email: string;
  email_verified: true;
};

export const hasVerifiedEmail = (payload: JWTPayload): payload is VerifiedEmailClaims =>
  typeof payload.email === "string" &&
  payload.email.length <= 320 &&
  payload.email === payload.email.trim() &&
  /^[^\s@]+@[^\s@]+$/.test(payload.email) &&
  payload.email_verified === true;
