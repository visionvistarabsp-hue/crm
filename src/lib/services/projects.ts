import { db } from '../db';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Actor } from '../api';
import { ApiError } from '../api';
import { hasPermission } from '../api';
import type { Project, Tower, Unit } from '../db/schema';
import { projects, towers, units } from '../db/schema';
import { projectCreateSchema, projectUpdateSchema, towerCreateSchema, unitCreateSchema, unitUpdateSchema } from '../validators';
import { writeAudit } from '../audit';

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(Number(n)) ? 0 : Number(n);
};

// ------------------------------------------------------------------
// Projects
// ------------------------------------------------------------------
/**
 * Project names are reference data every sales role needs (to tag a site
 * visit), but the per-project inventory rollup - especially
 * `inventoryValue`, the org's money in unsold stock - is management data.
 * Anyone with only `projects.view` therefore gets the identity fields and
 * nothing else. Redaction lives here rather than in the route so a future
 * caller cannot accidentally leak it.
 */
export async function listProjects(actor: Actor, filters: { status?: string; search?: string } = {}) {
  const canManage = hasPermission(actor.user, 'projects.manage');
  const conds: any[] = [];
  if (filters.status) conds.push(eq(projects.status, filters.status));
  if (filters.search) conds.push(sql`( ${projects.name} ILIKE ${`%${filters.search}%`} OR ${projects.code} ILIKE ${`%${filters.search}%`} )`);

  const rows = await db.query.projects.findMany({
    where: conds.length ? and(...conds) : undefined,
    orderBy: [asc(projects.name)],
    // Only management needs the tower + unit rollup; skip the joins entirely
    // for read-only callers instead of building rows and throwing them away.
    with: canManage ? { towers: { columns: { id: true, name: true } } } : undefined,
  });
  const stats = canManage
    ? await db
        .select({
          projectId: units.projectId,
          total: sql<number>`count(*)::int`,
          available: sql<number>`count(*) FILTER (WHERE ${units.status} = 'AVAILABLE')::int`,
          booked: sql<number>`count(*) FILTER (WHERE ${units.status} = 'BOOKED')::int`,
          held: sql<number>`count(*) FILTER (WHERE ${units.status} = 'HOLD')::int`,
          inventoryValue: sql<string>`coalesce(sum(${units.price}) FILTER (WHERE ${units.status} = 'AVAILABLE'), 0)`,
        })
        .from(units)
        .groupBy(units.projectId)
    : [];

  return rows.map((p) => {
    if (!canManage) {
      return { id: p.id, name: p.name, code: p.code, status: p.status, city: p.city };
    }
    const s = stats.find((x) => x.projectId === p.id);
    return {
      ...p,
      towerCount: (p as any).towers?.length ?? 0,
      unitStats: s
        ? { total: s.total, available: s.available, booked: s.booked, held: s.held, inventoryValue: s.inventoryValue }
        : { total: 0, available: 0, booked: 0, held: 0, inventoryValue: '0' },
    };
  });
}

export async function getProject(actor: Actor, id: string) {
  const rows = await db.query.projects.findFirst({
    where: eq(projects.id, id),
    with: {
      towers: { orderBy: (t: any, { asc: a }: any) => [a(t.name)], columns: { id: true, name: true, floors: true, unitsPerFloor: true } },
    },
  });
  if (!rows) return null;
  const towerStats = await db.select({ towerId: units.towerId, total: sql<number>`count(*)::int`, available: sql<number>`count(*) FILTER (WHERE ${units.status} = 'AVAILABLE')::int`, booked: sql<number>`count(*) FILTER (WHERE ${units.status} = 'BOOKED')::int` }).from(units).where(eq(units.projectId, id)).groupBy(units.towerId);
  return { ...rows, towerStats };
}

export async function createProject(actor: Actor, rawData: unknown): Promise<Project> {
  const data = projectCreateSchema.parse(rawData);
  const [proj] = await db.insert(projects).values({
    code: data.code.toUpperCase(),
    name: data.name,
    location: data.location,
    city: data.city,
    state: data.state,
    reraNo: data.reraNo ?? null,
    description: data.description ?? null,
    status: data.status,
    priceRangeMin: data.priceRangeMin != null ? String(data.priceRangeMin) : null,
    priceRangeMax: data.priceRangeMax != null ? String(data.priceRangeMax) : null,
    amenities: data.amenities ?? [],
  }).returning();
  await writeAudit({ actor, action: 'CREATE', entity: 'project', entityId: proj.id, newValue: { code: proj.code, name: proj.name } });
  return proj;
}

export async function updateProject(actor: Actor, id: string, rawData: unknown): Promise<Project> {
  const data = projectUpdateSchema.partial().parse(rawData);
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  (Object.keys(data) as Array<keyof typeof data>).forEach((k) => {
    if (data[k] === undefined) return;
    const v = data[k];
    if (k === 'priceRangeMin' || k === 'priceRangeMax') patch[k] = v != null ? String(v) : null;
    else patch[k] = v;
  });
  const [updated] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
  if (!updated) throw new ApiError(404, 'Project not found');
  await writeAudit({ actor, action: 'UPDATE', entity: 'project', entityId: id, newValue: data });
  return updated;
}

export async function deleteProject(actor: Actor, id: string): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id));
  await writeAudit({ actor, action: 'DELETE', entity: 'project', entityId: id });
}

// ------------------------------------------------------------------
// Towers + unit generation
// ------------------------------------------------------------------
export async function createTower(actor: Actor, rawData: unknown): Promise<Tower & { unitsCreated: number }> {
  const data = towerCreateSchema.parse(rawData);
  const proj = await db.query.projects.findFirst({ where: eq(projects.id, data.projectId) });
  if (!proj) throw new ApiError(404, 'Project not found');

  const [tower] = await db.insert(towers).values({ projectId: data.projectId, name: data.name, floors: data.floors, unitsPerFloor: data.unitsPerFloor }).returning();

  // bulk-generate units for each floor (unitNo = floor + running index)
  const rows: typeof units.$inferInsert[] = [];
  for (let f = 0; f < data.floors; f++) {
    for (let u = 1; u <= data.unitsPerFloor; u++) {
      rows.push({
        projectId: data.projectId,
        towerId: tower.id,
        unitNo: `${String(f + 1).padStart(2, '0')}${String(u).padStart(2, '0')}`,
        floor: f,
        unitType: 'APARTMENT',
        bhk: '2',
        price: '0',
        status: 'AVAILABLE',
      });
    }
  }
  if (rows.length) {
    await db.insert(units).values(rows).onConflictDoNothing({ target: [units.projectId, units.unitNo] });
  }
  await writeAudit({ actor, action: 'CREATE', entity: 'tower', entityId: tower.id, newValue: { name: data.name, units: rows.length } });
  return { ...tower, unitsCreated: rows.length };
}

export async function createUnit(actor: Actor, rawData: unknown): Promise<Unit> {
  const data = unitCreateSchema.parse(rawData);
  const [unit] = await db.insert(units).values({
    projectId: data.projectId,
    towerId: data.towerId ?? null,
    unitNo: data.unitNo,
    floor: data.floor ?? null,
    unitType: data.unitType,
    bhk: data.bhk,
    areaSqft: data.areaSqft != null ? String(data.areaSqft) : null,
    facing: data.facing ?? null,
    price: String(data.price),
    status: data.status,
  }).returning();
  await writeAudit({ actor, action: 'CREATE', entity: 'unit', entityId: unit.id, newValue: { unitNo: unit.unitNo } });
  return unit;
}

export async function updateUnit(actor: Actor, id: string, rawData: unknown): Promise<Unit | null> {
  const data = unitUpdateSchema.partial().parse(rawData);
  const existing = await db.query.units.findFirst({ where: eq(units.id, id) });
  if (!existing) throw new ApiError(404, 'Unit not found');

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  (Object.keys(data) as Array<keyof typeof data>).forEach((k) => {
    if (data[k] === undefined) return;
    const v = data[k];
    if (k === 'price' || k === 'areaSqft') patch[k] = v != null ? String(v) : null;
    else patch[k] = v;
  });
  const [updated] = await db.update(units).set(patch).where(eq(units.id, id)).returning();
  await writeAudit({ actor, action: 'UPDATE', entity: 'unit', entityId: id, newValue: patch });
  return updated ?? null;
}

export async function listUnits(actor: Actor, filters: { projectId?: string; towerId?: string; status?: string; bhk?: string; search?: string; page?: number; pageSize?: number } = {}) {
  const conds: any[] = [];
  if (filters.projectId) conds.push(eq(units.projectId, filters.projectId));
  if (filters.towerId) conds.push(eq(units.towerId, filters.towerId));
  if (filters.status) conds.push(eq(units.status, filters.status));
  if (filters.bhk) conds.push(eq(units.bhk, filters.bhk));
  if (filters.search) conds.push(sql`${units.unitNo} ILIKE ${`%${filters.search}%`}`);
  const where = conds.length ? and(...conds) : undefined;

  const [items, [{ count }]] = await Promise.all([
    db.query.units.findMany({
      where,
      with: { project: { columns: { id: true, name: true } }, tower: { columns: { id: true, name: true } } },
      orderBy: [asc(units.unitNo)],
      limit: filters.pageSize ?? 50,
      offset: ((filters.page ?? 1) - 1) * (filters.pageSize ?? 50),
    }),
    db.select({ count: sql<number>`count(*)::int` }).from(units).where(where ?? sql`true`),
  ]);
  return { items, total: count };
}

/** Place a time-boxed HOLD on an available unit. */
export async function holdUnit(actor: Actor, unitId: string, holdUntil: Date): Promise<Unit> {
  const unit = await db.query.units.findFirst({ where: eq(units.id, unitId) });
  if (!unit) throw new ApiError(404, 'Unit not found');
  if (unit.status !== 'AVAILABLE') throw new ApiError(422, `Unit is ${unit.status}`);
  const [updated] = await db.update(units).set({ status: 'HOLD', holdUntil, updatedAt: new Date() }).where(eq(units.id, unitId)).returning();
  await writeAudit({ actor, action: 'UPDATE', entity: 'unit', entityId: unitId, newValue: { status: 'HOLD', holdUntil } });
  return updated!;
}

export async function releaseUnitHold(actor: Actor, unitId: string): Promise<Unit> {
  const unit = await db.query.units.findFirst({ where: eq(units.id, unitId) });
  if (!unit) throw new ApiError(404, 'Unit not found');
  if (unit.status !== 'HOLD') throw new ApiError(422, `Unit is ${unit.status}`);
  const [updated] = await db.update(units).set({ status: 'AVAILABLE', holdUntil: null, updatedAt: new Date() }).where(eq(units.id, unitId)).returning();
  await writeAudit({ actor, action: 'UPDATE', entity: 'unit', entityId: unitId, newValue: { status: 'AVAILABLE' } });
  return updated!;
}

// ------------------------------------------------------------------
// Inventory dashboard
// ------------------------------------------------------------------
export async function getInventoryDashboard(projectId?: string) {
  const conds = projectId ? eq(units.projectId, projectId) : undefined;
  const stats = await db
    .select({
      projectId: units.projectId,
      projectName: projects.name,
      total: sql<number>`count(*)::int`,
      available: sql<number>`count(*) FILTER (WHERE ${units.status} = 'AVAILABLE')::int`,
      booked: sql<number>`count(*) FILTER (WHERE ${units.status} = 'BOOKED')::int`,
      held: sql<number>`count(*) FILTER (WHERE ${units.status} = 'HOLD')::int`,
      blocked: sql<number>`count(*) FILTER (WHERE ${units.status} = 'BLOCKED')::int`,
      availableValue: sql<string>`coalesce(sum(${units.price}) FILTER (WHERE ${units.status} = 'AVAILABLE'), 0)::text`,
      bookedValue: sql<string>`coalesce(sum(${units.price}) FILTER (WHERE ${units.status} = 'BOOKED'), 0)::text`,
    })
    .from(units)
    .leftJoin(projects, eq(units.projectId, projects.id))
    .where(conds ?? sql`true`)
    .groupBy(units.projectId, projects.name);

  const bhkGroup = sql<{ bhk: string; count: number }[]>`(
    select bhk, count(*)::int as count
    from units
    where ${conds ?? sql`true`}
    group by bhk
  )`;
  const byBhk = await db.execute(bhkGroup);

  return {
    projects: stats,
    byBhk: ((byBhk as unknown as { rows?: Array<{ bhk: string; count: number }> }).rows ?? []),
  };
}

export { num as projectNum };