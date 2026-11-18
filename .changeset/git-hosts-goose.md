---
"@weldall/goose": minor
---

Add the `publish_app` and `app_status` tools, which run `weldall app publish --json` and `weldall app status --json` for an app folder. Text from the repository, the Git host or other people is returned only under `data`, bounded and cleaned; conflicts, refused files and a pushed change without a pull request get their own outcomes, and an interrupted publish is never retried automatically. Set the extension timeout in Goose to 660 seconds (was 300), because a publish may take up to ten minutes. Add the `list_apps` tool, which lists the person's apps in the app registry with their re-verification state, and `confirm_app`, which confirms one app as still needed and is to be called only on the person's explicit request. An older CLI yields `cli_outdated`.
