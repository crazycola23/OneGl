import { ApiHttpError } from "../api/http.js";
import { publicId } from "./service.js";

/**
 * 任务组：一个用户视角的「任务」横跨多个采集任务，每个采集任务对应一个平台。
 *
 * 存在的理由见 migrations/0033_task_groups.sql：service_tasks.project_id 上的
 * UNIQUE 让「一个任务投多个平台」在数据层被拆成多个 task，而报告口径按
 * task_id 过滤，只能看到一个平台。组是这中间缺的一层。
 *
 * 组本身不声明平台。组的平台 = 成员 task 的 platforms 之和，避免出现
 * 「组声称支持豆包但底下没有豆包 task」这种无法验证的声明。
 */

function fail(message, status = 400, code = "invalid_request") {
  throw new ApiHttpError(status, code, message);
}

function normalizeName(value) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 200) fail("group name must contain between 1 and 200 characters");
  return name;
}

function normalizeExternalId(value) {
  if (value == null || value === "") return null;
  const id = String(value).trim();
  // 与 QUESTION_EXTERNAL_ID_PATTERN 同规则：调用方自有的键要能穿过 URL / JSON / 日志。
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
    fail("external_id must match [A-Za-z0-9._:-]{1,200}");
  }
  return id;
}

function normalizeTags(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail("tags must be an array");
  const tags = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (tags.length > 50) fail("tags must contain at most 50 entries");
  return tags;
}

/** 组详情：成员 task、平台集合、覆盖的批次与运行量。 */
function groupRow(row) {
  return {
    group_id: row.public_id,
    name: row.name,
    external_id: row.external_id ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    platforms: Array.isArray(row.platforms) ? row.platforms : [],
    brand: row.brand ?? null,
    task_count: Number(row.task_count ?? 0),
    tasks: Array.isArray(row.tasks) ? row.tasks : [],
    batch_count: Number(row.batch_count ?? 0),
    run_count: Number(row.run_count ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 组查询的公共 CTE。
 *
 * platforms 是成员 task 的 platforms 并集，批次/运行量只在 terminal 批次上统计 ——
 * 报告口径本身也只认结束批次，这里保持一致，否则列表页显示的数字会和对不上的报告打架。
 */
const GROUP_SELECT = `
  SELECT g.id, g.public_id, g.name, g.external_id, g.tags, g.created_at, g.updated_at,
         ARRAY(
           SELECT DISTINCT jsonb_array_elements_text(t.platforms)
             FROM service_task_group_members m
             JOIN service_tasks t ON t.id = m.task_id
            WHERE m.group_id = g.id
            ORDER BY 1
         ) AS platforms,
         (SELECT count(*)::int FROM service_task_group_members m WHERE m.group_id = g.id) AS task_count,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'task_id', t.public_id,
             'name', t.name,
             'platforms', t.platforms,
             'state', t.state,
             'batch_count', (SELECT count(*)::int
                               FROM service_task_executions e
                               JOIN sampling_batches b ON b.id = e.batch_id
                              WHERE e.task_id = t.id)
           ) ORDER BY t.id)
             FROM service_task_group_members m
             JOIN service_tasks t ON t.id = m.task_id
            WHERE m.group_id = g.id
         ), '[]'::jsonb) AS tasks,
         (SELECT count(DISTINCT b.id)::int
            FROM service_task_group_members m
            JOIN service_task_executions e ON e.task_id = m.task_id
            JOIN sampling_batches b ON b.id = e.batch_id
           WHERE m.group_id = g.id
             AND b.status IN ('completed','partial','failed','aborted')) AS batch_count,
         (SELECT count(DISTINCT r.id)::int
            FROM service_task_group_members m
            JOIN service_task_executions e ON e.task_id = m.task_id
            JOIN sampling_batches b ON b.id = e.batch_id
            JOIN runs r ON r.sampling_batch_id = b.id
           WHERE m.group_id = g.id
             AND b.status IN ('completed','partial','failed','aborted')) AS run_count,
         -- 组内品牌：成员 task 的 task_brand 优先，其次 project_brand。
         -- 多个不同品牌时返回 NULL，报告侧据此要求调用方显式给 brand。
         (SELECT CASE
                   WHEN count(DISTINCT COALESCE(t.target_brand, p.target_brand)) <= 1
                   THEN min(COALESCE(t.target_brand, p.target_brand))
                   ELSE NULL
                 END
            FROM service_task_group_members m
            JOIN service_tasks t ON t.id = m.task_id
            JOIN projects p ON p.id = t.project_id
           WHERE m.group_id = g.id
             AND COALESCE(t.target_brand, p.target_brand) IS NOT NULL) AS brand
    FROM service_task_groups g
`;

/**
 * 把数据库约束冲突翻译成 API 错误。
 *
 * 没有这一步的话，重复 external_id 会以 Postgres 原始错误冒到最外层，
 * 变成 500 —— 而它本质上是「这个客户标识已经存在」的 409。
 * 500 会让调用方以为服务坏了，实际上重试永远不会成功。
 */
function translateDbError(error) {
  if (error?.code !== "23505") return error;
  const constraint = String(error.constraint ?? "");
  if (constraint.includes("external_key")) {
    return new ApiHttpError(409, "group_external_id_conflict", "a task group with this external_id already exists");
  }
  if (constraint.includes("group_members_task_id_key") || constraint.includes("members_pair")) {
    return new ApiHttpError(409, "group_member_conflict", "task membership conflicts with an existing group");
  }
  return new ApiHttpError(409, "group_conflict", "task group conflicts with existing data");
}

export async function createTaskGroup(pool, { tenantId, name, externalId = null, tags = [], taskIds = [] }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const newGroupPublicId = publicId("grp");
    const { rows } = await client.query(
      `INSERT INTO service_task_groups (public_id, tenant_id, name, external_id, tags)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [newGroupPublicId, tenantId, normalizeName(name), normalizeExternalId(externalId), JSON.stringify(normalizeTags(tags))],
    );
    const groupDbId = rows[0].id;
    if (taskIds.length) {
      await attachTasks(client, { tenantId, groupDbId, groupPublicId: newGroupPublicId, taskIds });
    }
    await client.query("COMMIT");
    return getTaskGroup(pool, { tenantId, publicId: newGroupPublicId });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw translateDbError(error);
  } finally {
    client.release();
  }
}

export async function getTaskGroup(pool, { tenantId, publicId: groupPublicIdValue }) {
  const { rows } = await pool.query(`${GROUP_SELECT} WHERE g.tenant_id = $1 AND g.public_id = $2`, [
    tenantId,
    groupPublicIdValue,
  ]);
  return rows[0] ? groupRow(rows[0]) : null;
}

export async function listTaskGroups(pool, { tenantId, limit = 50, cursor = null } = {}) {
  const params = [tenantId];
  let where = "g.tenant_id = $1";
  if (cursor) {
    params.push(cursor);
    where += ` AND g.id < (SELECT id FROM service_task_groups WHERE public_id = $${params.length} AND tenant_id = $1)`;
  }
  params.push(limit);
  const { rows } = await pool.query(`${GROUP_SELECT} WHERE ${where} ORDER BY g.id DESC LIMIT $${params.length}`, params);
  return rows.map(groupRow);
}

/**
 * 把 task 挂到组上。
 *
 * 校验放在事务内逐条查：不能只信调用方给的 id —— task 可能属于别的租户，
 * 那样会把别人的采集数据挂进本租户的组，属于越权。
 *
 * ## 已在别组时必须显式失败，不能静默转移
 *
 * 早期版本写的是 `ON CONFLICT (task_id) DO UPDATE SET group_id = EXCLUDED.group_id`，
 * 后果是：把 task 加进新组会**悄悄把它从原组抢走**。实测就是这么丢了一批数据 ——
 * 主组的一个成员被「加进新组」的操作挪走，组看起来正常（只是少一个成员），
 * 报告的平台列表悄悄少一个，全程没有任何报错。
 *
 * 现在改成 DO NOTHING + 显式检查归属：已在同组是幂等成功；在别的组则 409
 * 并说明它当前属于哪个组。想转移请显式调用 detach，语义清晰无歧义。
 */
async function attachTasks(client, { tenantId, groupDbId, groupPublicId, taskIds }) {
  for (const taskPublicId of taskIds) {
    const { rows } = await client.query(
      "SELECT id FROM service_tasks WHERE tenant_id = $1 AND public_id = $2",
      [tenantId, taskPublicId],
    );
    if (!rows[0]) fail(`task not found: ${taskPublicId}`, 404, "task_not_found");
    const taskDbId = rows[0].id;

    const inserted = await client.query(
      `INSERT INTO service_task_group_members (group_id, task_id) VALUES ($1, $2)
       ON CONFLICT (task_id) DO NOTHING
       RETURNING task_id`,
      [groupDbId, taskDbId],
    );
    if (inserted.rowCount > 0) continue;

    // 没插入成功：要么已在同组（幂等成功），要么已在别的组（冲突，必须报错）
    const owner = await client.query(
      `SELECT g.public_id FROM service_task_group_members m
         JOIN service_task_groups g ON g.id = m.group_id
        WHERE m.task_id = $1`,
      [taskDbId],
    );
    const ownerId = owner.rows[0]?.public_id;
    if (ownerId === groupPublicId) continue;
    fail(
      `task ${taskPublicId} already belongs to group ${ownerId ?? "unknown"}; ` +
        "detach it first if you intend to move it",
      409,
      "task_already_in_group",
    );
  }
}

export async function attachTaskGroupMembers(pool, { tenantId, publicId: groupPublicIdValue, taskIds }) {
  const group = await requireGroup(pool, { tenantId, publicId: groupPublicIdValue });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await attachTasks(client, {
      tenantId,
      groupDbId: group.id,
      groupPublicId: groupPublicIdValue,
      taskIds,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw translateDbError(error);
  } finally {
    client.release();
  }
  return getTaskGroup(pool, { tenantId, publicId: groupPublicIdValue });
}

export async function detachTaskGroupMember(pool, { tenantId, publicId: groupPublicIdValue, taskId }) {
  const group = await requireGroup(pool, { tenantId, publicId: groupPublicIdValue });
  const { rowCount } = await pool.query(
    "DELETE FROM service_task_group_members WHERE group_id = $1 AND task_id = $2",
    [group.id, taskId],
  );
  return rowCount > 0;
}

export async function updateTaskGroup(pool, { tenantId, publicId: groupPublicIdValue, patch = {} }) {
  const group = await requireGroup(pool, { tenantId, publicId: groupPublicIdValue });
  const sets = [];
  const params = [group.id];
  if (patch.name !== undefined) {
    params.push(normalizeName(patch.name));
    sets.push(`name = $${params.length}`);
  }
  if (patch.externalId !== undefined) {
    params.push(normalizeExternalId(patch.externalId));
    sets.push(`external_id = $${params.length}`);
  }
  if (patch.tags !== undefined) {
    params.push(JSON.stringify(normalizeTags(patch.tags)));
    sets.push(`tags = $${params.length}::jsonb`);
  }
  if (!sets.length) return getTaskGroup(pool, { tenantId, publicId: groupPublicIdValue });
  try {
    await pool.query(`UPDATE service_task_groups SET ${sets.join(", ")} WHERE id = $1`, params);
  } catch (error) {
    throw translateDbError(error);
  }
  return getTaskGroup(pool, { tenantId, publicId: groupPublicIdValue });
}

export async function deleteTaskGroup(pool, { tenantId, publicId: groupPublicIdValue }) {
  const group = await requireGroup(pool, { tenantId, publicId: groupPublicIdValue });
  const { rowCount } = await pool.query("DELETE FROM service_task_groups WHERE id = $1", [group.id]);
  return rowCount > 0;
}

async function requireGroup(pool, { tenantId, publicId: groupPublicIdValue }) {
  if (!groupPublicIdValue) fail("group_id is required");
  const { rows } = await pool.query(
    "SELECT id FROM service_task_groups WHERE tenant_id = $1 AND public_id = $2",
    [tenantId, groupPublicIdValue],
  );
  if (!rows[0]) fail("task group was not found", 404, "group_not_found");
  return rows[0];
}

/**
 * 解析报告请求里的任务定位：既接受单个 task，也接受组。
 *
 * 返回值刻意把「组」和「单 task」区分开（kind 字段），因为组没有单一 project，
 * 目标品牌只能从成员 task 的 project 里取。取不到时返回 null，报告层据此把
 * 品牌指标标成不可用 —— 报告阶段不提供 brand 覆盖入口。
 */
export async function resolveReportScope(client, { tenantId, taskId, groupId = null }) {
  if (groupId) {
    const { rows } = await client.query(
      `SELECT g.id, g.public_id, g.name, g.external_id
         FROM service_task_groups g
        WHERE g.tenant_id = $1 AND g.public_id = $2`,
      [tenantId, groupId],
    );
    if (!rows[0]) fail("task group was not found", 404, "group_not_found");
    const group = rows[0];

    const members = await client.query(
      `SELECT t.id, t.public_id, t.name, t.platforms, t.project_id, t.target_brand,
              p.name AS project_name, p.target_brand AS project_brand
         FROM service_task_group_members m
         JOIN service_tasks t ON t.id = m.task_id
         JOIN projects p ON p.id = t.project_id
        WHERE m.group_id = $1
        ORDER BY t.id`,
      [group.id],
    );
    if (!members.rows.length) fail("task group has no member tasks", 422, "group_empty");

    return {
      kind: "group",
      id: group.id,
      public_id: group.public_id,
      name: group.name,
      external_id: group.external_id ?? null,
      // 品牌取自成员 task 的 project；多个不同品牌时置空，交给调用方显式指定。
      brand: resolveGroupBrand(members.rows),
      platforms: [...new Set(members.rows.flatMap((row) => normalizePlatforms(row.platforms)))],
      projects: [...new Set(members.rows.map((row) => row.project_id))].map((id) => ({
        project_id: Number(id),
        name: members.rows.find((row) => row.project_id === id).project_name,
      })),
      taskIds: members.rows.map((row) => row.id),
      tasks: members.rows.map((row) => ({
        task_id: row.public_id,
        name: row.name,
        platforms: normalizePlatforms(row.platforms),
        project_id: Number(row.project_id),
        project_name: row.project_name,
      })),
    };
  }

  if (!taskId) fail("task_id or group_id is required");
  const { rows } = await client.query(
    `SELECT t.id, t.public_id, t.name, t.platforms, t.project_id, t.target_brand,
            p.name AS project_name, p.target_brand AS project_brand
       FROM service_tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.tenant_id = $1 AND t.public_id = $2`,
    [tenantId, taskId],
  );
  if (!rows[0]) fail("task was not found", 404, "task_not_found");
  const row = rows[0];
  return {
    kind: "task",
    id: row.id,
    public_id: row.public_id,
    name: row.name,
    external_id: null,
    brand: row.task_brand ?? row.project_brand ?? null,
    platforms: normalizePlatforms(row.platforms),
    projects: [{ project_id: Number(row.project_id), name: row.project_name }],
    taskIds: [row.id],
    tasks: [
      {
        task_id: row.public_id,
        name: row.name,
        platforms: normalizePlatforms(row.platforms),
        project_id: Number(row.project_id),
        project_name: row.project_name,
      },
    ],
  };
}

function normalizePlatforms(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 组内品牌一致性检查。
 *
 * 组内所有 project 应当是同一个目标品牌的多次采集。品牌不一致时返回 null，
 * 报告层会把品牌指标标成不可用并说明原因 —— 拿一个不明确的品牌去算提及率
 * 只会产出看起来精确、实际无意义的数字。报告请求不再接受 brand 覆盖。
 */
function resolveGroupBrand(rows) {
  const brands = [...new Set(rows.map((row) => row.task_brand ?? row.project_brand ?? null).filter(Boolean))];
  return brands.length === 1 ? brands[0] : null;
}
