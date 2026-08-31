const DEFAULT_MAX_REQUEST_SIZE = 1_000_000;

export async function readJsonBody(
  request: Request,
  maxRequestSize = DEFAULT_MAX_REQUEST_SIZE,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: 400 | 413 | 415 }> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    return { ok: false, error: "Content-Type must be application/json.", status: 415 };
  }
  if (!request.body) return { ok: false, error: "Invalid JSON body.", status: 400 };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxRequestSize) {
      await reader.cancel();
      return { ok: false, error: "Request body is too large.", status: 413 };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "Invalid JSON body.", status: 400 };
  }
}
