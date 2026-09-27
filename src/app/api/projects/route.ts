import { withApi } from '@/lib/handlers';
import { listProjects, createProject } from '@/lib/services/projects';
import { requireAnyPermission, requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, req) => {
  // Listing is read-only: site-visit and meeting forms need to name a project,
  // so anyone with `projects.view` may read. listProjects() redacts the
  // inventory rollup for non-managers.
  requireAnyPermission(actor.user, ['projects.view', 'projects.manage']);
  const rows = await listProjects(actor, { status: req.nextUrl.searchParams.get('status') ?? undefined, search: req.nextUrl.searchParams.get('q') ?? undefined });
  return { items: rows };
});

export const POST = withApi(async (actor, req) => {
  requirePermission(actor.user, 'projects.manage');
  const body = await readJson(req);
  const project = await createProject(actor, body);
  return { project, ok: true };
});