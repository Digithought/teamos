export interface Project {
	code: string; // identifier (e.g. 'newWebsite') also used by folder names
	name: string;
	description: string;
	status: 'planning' | 'active' | 'paused' | 'completed' | 'cancelled';
	targetDate?: string;
	milestones?: {
		title: string;
		targetDate?: string;
		complete: boolean;
	}[];
}

export interface ProjectsManifest {
	projects: Project[];
}
