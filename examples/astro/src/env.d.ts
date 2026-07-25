/// <reference types="astro/client" />
import type { AuthContext } from "@weldall/sdk";
declare global {
  namespace App {
    interface Locals {
      weldallAuth?: AuthContext;
    }
  }
}
export {};
