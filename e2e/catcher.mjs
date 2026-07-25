import { createServer } from "node:http";

let capturedRequests = [];

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://catcher.local");
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/_control/reset") {
    capturedRequests = [];
    json(response, 200, { count: 0 });
    return;
  }
  if (request.method === "GET" && url.pathname === "/_control/count") {
    json(response, 200, { count: capturedRequests.length });
    return;
  }

  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    capturedRequests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    json(response, 200, { captured: true });
  });
}).listen(3003, "0.0.0.0");
