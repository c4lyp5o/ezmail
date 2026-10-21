// Resolves a special-use folder (RFC 6154 "\Trash", "\Sent", …) from the
// folder list, falling back to a conventional name. Servers name these
// differently ("Deleted Items", "Sent Mail", "Bin"), so never hard-code paths.
export function specialFolder(folders, use, fallbackName) {
	return (
		folders.find((f) => f.specialUse === `\\${use}`)?.path ||
		folders.find((f) => f.name?.toLowerCase() === fallbackName.toLowerCase())
			?.path ||
		null
	);
}
