# Pi citation patch

`@weclio/pi-web` installs a local compatibility patch during `postinstall` so customer installations preserve OpenAI Responses web citations.

- Target package/version: `@earendil-works/pi-ai@0.85.1`
- Script: `scripts/apply-pi-citation-patch.cjs`
- Runtime target: `dist/api/openai-responses-shared.js`
- Source location: `processResponsesStream()` → `response.output_item.done` → `message`
- Change: persist `output_text.annotations` of type `url_citation` on the text block as `citations`.

The script is idempotent. It fails when the installed `pi-ai` version or code anchors differ, so a Pi upgrade cannot silently ship an invalid patch.

## Pi upgrade

1. Upgrade all four `@earendil-works/pi-*` packages together.
2. Update `PI_AI_VERSION` and the anchors/replacement in `scripts/apply-pi-citation-patch.cjs`.
3. Run `npm install` and verify the script applies.
4. Run the citation tests.

Weclio always removes raw `cite…` tokens. When citation metadata is available, it renders source links.
