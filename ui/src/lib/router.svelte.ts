class Router {
	hash = $state(window.location.hash.slice(1) || '/');

	constructor() {
		window.addEventListener('hashchange', () => {
			this.hash = window.location.hash.slice(1) || '/';
		});
	}

	get path() { return this.hash.split('?')[0]; }

	get query(): Record<string, string> {
		const qs = this.hash.split('?')[1];
		return qs ? Object.fromEntries(new URLSearchParams(qs)) : {};
	}

	navigate(path: string) {
		window.location.hash = path;
	}

	match(pattern: string): Record<string, string> | null {
		const pp = pattern.split('/');
		const hp = this.path.split('/');
		if (pp.length !== hp.length) return null;
		const params: Record<string, string> = {};
		for (let i = 0; i < pp.length; i++) {
			if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(hp[i]);
			else if (pp[i] !== hp[i]) return null;
		}
		return params;
	}
}

export const router = new Router();
