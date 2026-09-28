---
"@weldall/weldall": minor
---

Add a read-only `/statistics` page for anyone holding the new system scope `weldall:statistics`. It shows org-wide usage over the last 24 hours, 7, 30 or 90 days: active people with the change from the previous period, token exchanges by resource, the people who retrieved each skill and the number of machine clients. `weldall:administer` does not include the scope, and the page remembers the last interval in a cookie.
