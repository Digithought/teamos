const STORAGE_KEY = 'teamos-me';

class Identity {
	name = $state<string | null>(localStorage.getItem(STORAGE_KEY));
	locked = $state<boolean>(false);
	source = $state<string | null>(null);
	email = $state<string | null>(null);
	resolved = $state<boolean>(false);
	/** Set when the server resolved a proxy identity whose email isn't in members.json. */
	unknownEmail = $state<string | null>(null);

	async init() {
		try {
			const res = await fetch('/api/me');
			if (res.ok) {
				const me = await res.json();
				if (me.locked) {
					this.locked = true;
					this.source = me.source ?? null;
					this.email = me.email ?? null;
					if (me.name) {
						this.name = me.name;
						localStorage.setItem(STORAGE_KEY, me.name);
					} else {
						this.name = null;
						this.unknownEmail = me.email ?? 'unknown';
					}
				}
			}
		} catch {
			// Server unreachable — fall back to localStorage (already loaded in the field initializer).
		}
		this.resolved = true;
	}

	set(name: string) {
		if (this.locked) return;
		this.name = name;
		localStorage.setItem(STORAGE_KEY, name);
	}

	clear() {
		if (this.locked) return;
		this.name = null;
		localStorage.removeItem(STORAGE_KEY);
	}

	get isSet(): boolean {
		return this.name !== null;
	}
}

export const identity = new Identity();
identity.init();
