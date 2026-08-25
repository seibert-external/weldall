import { resolveLucideIconNode } from "@/server/skills/appearance-icons";

export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  const iconNode = await resolveLucideIconNode(name);
  if (!iconNode) return new Response(null, { status: 404 });

  const children = iconNode
    .map(([element, attributes]) => {
      const serializedAttributes = Object.entries(attributes)
        .filter(([key]) => key !== "key")
        .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
        .join(" ");
      return `<${element}${serializedAttributes ? ` ${serializedAttributes}` : ""}/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;

  return new Response(svg, {
    headers: {
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
      "content-type": "image/svg+xml; charset=utf-8",
    },
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
