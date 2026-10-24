import piStash from "../../extensions/stash.ts";

const commands = new Map();
piStash({
	on() {},
	registerShortcut() {},
	appendEntry() {},
	registerCommand(name, definition) { commands.set(name, definition); },
});

process.on("message", async ({ cwd, draft, editor }) => {
	let editorText = editor ? draft : "";
	const notifications = [];
	const ctx = {
		cwd, mode: "tui", hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_, text) => text },
			setStatus() {},
			notify(message, type) { notifications.push({ message, type }); },
			getEditorText: () => editorText,
			setEditorText(text) { editorText = text; },
		},
	};
	try {
		await commands.get("stash").handler(editor ? "" : draft, ctx);
		process.send({ editorText, notifications });
	} catch (error) {
		process.send({ editorText, notifications, error: String(error) });
	}
});
process.send({ ready: true });
