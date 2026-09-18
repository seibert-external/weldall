---
"@weldall/cli": minor
---

Hide the IaC commands (`init`, `validate`, `plan`, `up`, `import`, `unmanage`, `state`) from `weldall --help` and the bare `weldall` output unless a machine client is configured. They authenticate with `WELDALL_M2M_*`, so a browser login alone never makes them usable. The commands stay runnable while hidden.
