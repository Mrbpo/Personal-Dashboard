// Test-only bootstrap. Never allow the production database or original library.
if(!process.env.KERNEL_DATABASE_URL)throw new Error('An isolated PostgreSQL connection is required');
const database=new URL(process.env.KERNEL_DATABASE_URL);
database.pathname='/pdf_acceptance_20261006';
process.env.KERNEL_DATABASE_URL=database.toString();
if(process.env.DATABASE_URL!==':memory:'&&!process.env.DATABASE_URL?.includes('pdf-data'))throw new Error('PDF acceptance requires a dedicated SQLite file');
if(!process.env.LIBRARY_DIR?.startsWith('/pdf-data/')&&!process.env.LIBRARY_DIR?.startsWith('/tmp/study-tests-'))throw new Error('PDF acceptance requires a dedicated original file store');
if(!process.env.SERVICE_VAULT_DIR?.startsWith('/tmp/study-tests-'))process.env.SERVICE_VAULT_DIR='/pdf-data/private';
process.env.CHATGPT_AUTO='false';
