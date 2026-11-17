---
"@weldall/goose": minor
---

Add the `publish_app` and `app_status` tools, which run `weldall app publish --json` and `weldall app status --json` for an app folder. Text from the repository, the Git host or other people is returned only under `data`, bounded and cleaned; conflicts, refused files and a pushed change without a pull request get their own outcomes, and an interrupted publish is never retried automatically. Set the extension timeout in Goose to 660 seconds (was 300), because a publish may take up to ten minutes. An older CLI yields `cli_outdated`.
