/**
 * Augment agent adapter.
 * Returns { cmd, args } for spawning.
 */
export function createAuggieAdapter(instructionFile) {
	return {
		cmd: 'auggie',
		args: ['--print', '--instruction', instructionFile],
	};
}
