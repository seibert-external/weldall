---
"@weldall/cli": patch
"@weldall/goose": patch
"@weldall/sdk": patch
---

Preserve MCP App connectDomains in the bundled CLI validation schema so fetch-based PDF.js views work end to end. Keep object embeds blocked and remove obsolete object-origin forwarding; legacy objectDomains options remain accepted but ignored. Add a regression for connection metadata through authenticated native CLI reads.
