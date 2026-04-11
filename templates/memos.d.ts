export interface NewsItem {
  title: string;
  content: string;
  postedAt: string; // ISO
  expiresAt?: string;
  importance: 'low' | 'medium' | 'high' | 'critical';
  authorName?: string;
  /** Related project Codes */
  projectCodes?: string[];
}

export interface NewsManifest {
  items: NewsItem[];
}
