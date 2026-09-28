import { database } from '../lib/database.ts';

await database.prepare("DELETE FROM service_leases WHERE id='worker-primary'").run();
