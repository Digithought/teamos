/**
 * S3-compatible sync adapter — uses AWS SDK or rclone for sync.
 * Works with Tigris (Fly.io), MinIO (local dev), or any S3-compatible store.
 *
 * Configuration:
 * {
 *   endpoint: string,         // e.g. "https://fly.storage.tigris.dev" or "http://localhost:9000"
 *   bucket: string,           // e.g. "teamos-workspace"
 *   region: string,           // e.g. "auto" or "us-east-1"
 *   accessKeyId: string,      // AWS access key
 *   secretAccessKey: string,  // AWS secret key
 *   forcePathStyle: boolean   // true for MinIO
 * }
 */
export class S3SyncAdapter {
	constructor(config) {
		this.endpoint = config.endpoint;
		this.bucket = config.bucket;
		this.region = config.region || 'auto';
		this.accessKeyId = config.accessKeyId;
		this.secretAccessKey = config.secretAccessKey;
		this.forcePathStyle = config.forcePathStyle || false;
		this.client = null;
	}

	/**
	 * Lazily initialize the S3 client.
	 */
	async _getClient() {
		if (this.client) return this.client;
		try {
			const { S3Client } = await import('@aws-sdk/client-s3');
			this.client = new S3Client({
				endpoint: this.endpoint,
				region: this.region,
				credentials: {
					accessKeyId: this.accessKeyId,
					secretAccessKey: this.secretAccessKey,
				},
				forcePathStyle: this.forcePathStyle,
			});
			return this.client;
		} catch (err) {
			throw new Error(`Failed to initialize S3 client. Is @aws-sdk/client-s3 installed? ${err.message}`);
		}
	}

	/**
	 * Pull latest state from S3 bucket to local working directory.
	 * Uses rclone for efficient sync if available, falls back to SDK.
	 */
	async pull(workDir) {
		// TODO Phase 2: Implement S3 → local sync
		// Option A: rclone sync remote:bucket/team/ {workDir}/team/
		// Option B: AWS SDK ListObjectsV2 + GetObject for changed files
		console.log(`[s3] pull: syncing from s3://${this.bucket} to ${workDir}`);
		console.warn('[s3] pull() not yet fully implemented — Phase 2');
	}

	/**
	 * Push local changes to S3 bucket.
	 * The label is logged but S3 doesn't have commits — bucket versioning provides history.
	 */
	async push(workDir, label) {
		// TODO Phase 2: Implement local → S3 sync
		// Option A: rclone sync {workDir}/team/ remote:bucket/team/
		// Option B: AWS SDK PutObject for changed files (compute diffs via timestamps)
		console.log(`[s3] push: syncing ${workDir} to s3://${this.bucket} (${label})`);
		console.warn('[s3] push() not yet fully implemented — Phase 2');
	}

	/**
	 * One-time setup: create bucket if needed, enable versioning.
	 */
	async init() {
		// TODO Phase 2: Create bucket + enable versioning
		console.log(`[s3] init: ensuring bucket ${this.bucket} exists`);
		console.warn('[s3] init() not yet fully implemented — Phase 2');
	}
}
