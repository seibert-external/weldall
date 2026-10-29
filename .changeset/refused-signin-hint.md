---
"@weldall/cli": patch
---

`weldall whoami` and `weldall status` tell you to run `weldall login` when Weldall refuses the saved sign-in at userinfo (HTTP 401). A refresh does not help there: the server refuses every token of that sign-in once the browser sign-in it came from has ended.
