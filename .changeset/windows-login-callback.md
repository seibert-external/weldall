---
"@weldall/cli": patch
---

Fix `weldall login` leaving the browser on "127.0.0.1 refused to connect" after Approve: the loopback keeps answering a repeated callback request until login has finished.
