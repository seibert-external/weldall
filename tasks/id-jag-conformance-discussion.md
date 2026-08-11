# ID-JAG Conformance Follow-up — Discussion

## Status

Up for discussion. This is not an approved implementation plan and is explicitly out of scope for `tasks/m2m.md`.

## Context

Weldall currently issues ID-JAGs through a refresh-token exchange. Completing the broader draft profile should be considered separately from machine-to-machine authentication.

## Discussion items

A future ID-JAG conformance plan may need to:

- accept an ID Token or another supported identity assertion as `subject_token`;
- decide whether to continue accepting refresh tokens as `subject_token`;
- publish the metadata required by the pinned ID-JAG draft;
- validate client authentication according to the draft;
- track changes to the pinned ID-JAG draft;
- retain the existing audience, resource, scope, DPoP, and replay protections.

## Open questions

- Which identity assertion types should Weldall accept?
- Should refresh-token exchange remain supported alongside identity assertions?
- Which draft version should be pinned, and how should upgrades be reviewed?
- What compatibility and migration guarantees are required for existing CLI users?
