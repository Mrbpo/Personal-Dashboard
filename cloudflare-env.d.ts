declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    CANVAS_BASE_URL?: string;
    CANVAS_TOKEN?: string;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
    OWNER_EMAIL?: string;
  }
}
