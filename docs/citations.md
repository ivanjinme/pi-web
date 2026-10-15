# Native citations

Native citation extraction belongs to the optional `@weclio/pi-citations` Pi extension, not the web host. Load `weclio-plugins/extensions/weclio-citations` through the user's or project's Pi extension configuration. The extension requires Pi >=1.0.2 and does not modify installed SDK files or run installation patches.

For OpenAI Responses APIs, the extension collects finalized URL annotations through `provider_stream_event`, binds them to the matching assistant text block at `message_end`, and supplies `text.citations`. It persists the completed message metadata and the citation registry through Pi. URL and optional title are preserved; provider offsets are not exported because other extensions can rewrite the text.

The web UI only consumes the optional `text.citations` transport field and renders the source list. It does not import the extension or perform extraction. Browsing historical sessions continues to work without a live extension, including sessions whose citation metadata was already persisted.

Without the extension, vanilla Pi 1.0.2 does not preserve these raw provider annotations. Ordinary Markdown links still display normally. No `postinstall` patch or SDK code-anchor maintenance is required.
