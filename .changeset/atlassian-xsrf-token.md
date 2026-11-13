---
"@weldall/weldall": patch
---

Atlassian connections now forward `X-Atlassian-Token`, so Jira attachment uploads no longer fail with "XSRF check failed". Other `X-Atlassian-*` headers are still removed.
