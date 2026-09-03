---
"@weldall/sdk": minor
---

Add `@weldall/sdk/starlight`: a Starlight/Astro integration that exposes a Weldall-SDK-authenticated full-text search endpoint (`/api/search`) over the site's own MDX content. It indexes the content at build time (Orama, German stemming), protects the endpoint with DPoP + a `search:read`-style scope, and publishes a skill catalog so Weldall auto-discovers the `search` skill. The interface mirrors `initWeldall(host, options)`. Orama and gray-matter are optional peer dependencies, loaded lazily, so the core SDK footprint is unchanged.
