import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import { saveStore } from '@/server/store';

// Explicitly seed the in-memory test store before each test suite runs,
// since getStore() in product code no longer auto-seeds demo data (S0-11b).
saveStore(loadCommittedSeedStore());
