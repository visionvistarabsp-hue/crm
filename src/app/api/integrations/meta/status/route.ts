import { withApi } from '@/lib/handlers';
import { getMetaIntegrationStatus } from '@/lib/services/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async () => getMetaIntegrationStatus());