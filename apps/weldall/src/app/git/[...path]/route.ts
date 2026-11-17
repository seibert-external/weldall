import { createGitProxy } from "@/server/git-proxy/handler";

// Git traffic is streamed through Node; route handlers have no body size limit of their own (only
// a `proxy.ts`, which this app does not have, would add `proxyClientMaxBodySize`).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const handle = createGitProxy();

/** `GET /git/<connector>/<owner>/<repository>.git/info/refs?service=git-upload-pack|git-receive-pack` */
export function GET(request: Request) {
  return handle(request);
}

/** `POST /git/<connector>/<owner>/<repository>.git/git-upload-pack|git-receive-pack` */
export function POST(request: Request) {
  return handle(request);
}
