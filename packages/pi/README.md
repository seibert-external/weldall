# @weldall/pi

Pi extension that loads administrator-managed WeldAll Markdown skills for the user signed in through the npm `@weldall/cli` package. Configure the issuer and sign in with `weldall config set-issuer <url>` and `weldall login`, then install the extension with `pi install npm:@weldall/pi` and restart Pi.

At session startup, the extension adds every visible skill's current instructions to Pi's context and registers it as a namespaced `/weldall-<skill-id>` command. Selecting the command activates the complete instructions for that turn. Run `/weldall-refresh` to re-fetch the skill catalog and update the available commands without restarting Pi.

The extension delegates authentication and API behavior to the npm CLI dependency. It does not use or fall back to a standalone WeldAll binary.
