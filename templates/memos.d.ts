export interface NewsItem {
	title: string;
	content: string;
	postedAt: string; // ISO
	/** ISO; set when the memo's wording or importance is edited — re-surfaces it to members as REVISED. */
	revisedAt?: string;
	expiresAt?: string;
	importance: 'low' | 'medium' | 'high' | 'critical';
	authorName?: string;
	/** Related project Codes */
	projectCodes?: string[];
}

export interface NewsManifest {
	items: NewsItem[];
}
