import { withApi, param } from '@/lib/handlers';
import { getProject, updateProject, deleteProject, createTower } from '@/lib/services/projects';
import { requirePermission } from '@/lib/api';
import { readJson } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'projects.manage');
  const project = await getProject(actor, await param(ctx, 'id'));
  return project ?? { status: 404, error: { message: 'Project not found' } };
});

export const PATCH = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'projects.manage');
  const body = await readJson(req);
  const project = await updateProject(actor, await param(ctx, 'id'), body);
  return { project, ok: true };
});

export const DELETE = withApi(async (actor, _req, ctx) => {
  requirePermission(actor.user, 'projects.manage');
  await deleteProject(actor, await param(ctx, 'id'));
});

// create tower within a project
export const PUT = withApi(async (actor, req, ctx) => {
  requirePermission(actor.user, 'projects.manage');
  const body: any = await readJson(req);
  const tower = await createTower(actor, { projectId: await param(ctx, 'id'), name: body.name, floors: body.floors, unitsPerFloor: body.unitsPerFloor });
  return { tower, ok: true };
});