const STORAGE_KEY = 'teamos-me';

class Identity {
	name = $state<string | null>(localStorage.getItem(STORAGE_KEY));

	set(name: string) {
		this.name = name;
		localStorage.setItem(STORAGE_KEY, name);
	}

	clear() {
		this.name = null;
		localStorage.removeItem(STORAGE_KEY);
	}

	get isSet(): boolean {
		return this.name !== null;
	}
}

export const identity = new Identity();
