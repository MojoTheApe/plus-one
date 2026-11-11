# Plus One: agent guide

Start with README.md and docs/runtime/PORTABLE.md. A fresh installation uses
the user's own Telegram token, numeric owner ID and Codex login. Explain the
BotFather and device-login steps, and let the user authenticate privately.
Never reuse another installation's identity, credentials, profiles or services.

Keep the private instance directory outside this checkout. Do not print tokens,
auth files, private personas, member lists or conversation contents in logs.
Run the documented non-polling connection check before starting. Use a distinct
instance directory and Compose project for every token; never start two pollers
with the same token. Preserve existing state and back it up before updates.

After installation, guide the owner to Start in the bot's private chat. Setup
uses free text; no source edits are needed for ordinary profiles and group rules.
Settings and profile/rule lists are owner-only. A Telegram administrator is not
automatically the installation owner.

For development, use supported Node, install the lockfile dependencies and run
the relevant offline tests. Tests must not inherit real credentials or private
paths. Keep fixture, real model, container, installed and physical-client evidence
distinct. Do not send Telegram messages, call a paid AI account or restart a live
installation without authorization for that task. Preserve feature permissions
and group boundaries when changing routing. Configured rules invoke supported
actions; they never execute arbitrary code or shell commands.
