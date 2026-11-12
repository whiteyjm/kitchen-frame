// Grocery and to-do lists from Todoist (API v1), proxied so the token never reaches the frame.
// Secret: TODOIST_TOKEN (Todoist → Settings → Integrations → Developer → API token).
// Vars: TODOIST_GROCERY_PROJECT, TODOIST_TODO_PROJECT (project names, default "Groceries" / "To-do").
import { visibleNote, splitQuantity, withQuantity, quantityFromDescription, setDescriptionQuantity, clampQty } from '../shared/product.js';

const API = 'https://api.todoist.com/api/v1';
export const LISTS = { groceries: 'TODOIST_GROCERY_PROJECT', todo: 'TODOIST_TODO_PROJECT' };
const DEFAULT_NAMES = { groceries: 'Groceries', todo: 'To-do' };

let projectIds = null;   // name (lowercase) -> id, cached per isolate
let listing = null;      // the /projects request in flight, shared by concurrent callers
const META_MS = 10 * 60 * 1000;
const metaCache = new Map(); // project id -> { at, sections, people }: they change rarely, tasks often

async function call(env, path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + env.TODOIST_TOKEN, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error('Todoist HTTP ' + res.status);
  return res.status === 204 ? null : res.json();
}

async function paged(env, path) {
  const out = [];
  let cursor = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const page = await call(env, path + sep + 'limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    out.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor && out.length < 1000);
  return out;
}

async function projectId(env, list) {
  const name = (env[LISTS[list]] || DEFAULT_NAMES[list]).toLowerCase();
  if (!projectIds || !projectIds.has(name)) {
    listing ||= paged(env, '/projects')
      .then((ps) => { projectIds = new Map(ps.map((p) => [p.name.toLowerCase(), p.id])); })
      .finally(() => { listing = null; });
    await listing;
  }
  const id = projectIds.get(name);
  if (!id) throw new Error('No Todoist project named "' + (env[LISTS[list]] || DEFAULT_NAMES[list]) + '"');
  return id;
}

// Tasks plus the project's sections (in Todoist order) and, for shared projects, who's on it, so
// the frame can draw a board and show assignees.
export async function getList(env, list) {
  const pid = encodeURIComponent(await projectId(env, list));
  const [tasks, meta] = await Promise.all([paged(env, '/tasks?project_id=' + pid), projectMeta(env, pid)]);
  return {
    project: env[LISTS[list]] || DEFAULT_NAMES[list],
    items: sortTasks(tasks, list),
    ...meta,
    updated: new Date().toISOString(),
  };
}

// Sections and collaborators, cached per isolate for META_MS (the frame polls tasks every minute).
async function projectMeta(env, pid) {
  const hit = metaCache.get(pid);
  if (hit && Date.now() - hit.at < META_MS) return hit.meta;
  const [sections, people] = await Promise.all([
    paged(env, '/sections?project_id=' + pid).catch(() => []),
    paged(env, '/projects/' + pid + '/collaborators').catch(() => []), // only shared projects have any
  ]);
  const meta = {
    sections: sections.sort((a, b) => (a.section_order ?? 0) - (b.section_order ?? 0)).map((x) => ({ id: x.id, name: x.name })),
    people: Object.fromEntries(people.map((c) => [String(c.id), c.name || c.email || 'Someone'])),
  };
  metaCache.set(pid, { at: Date.now(), meta });
  return meta;
}


// Groceries keep Todoist's own order. To-dos put dated items first (overdue at the top).
export function sortTasks(tasks, list) {
  return tasks
    .filter((t) => !t.parent_id && !t.checked)
    .sort((a, b) => {
      if (list === 'todo') {
        const da = a.due?.date || '9999', db = b.due?.date || '9999';
        if (da !== db) return da < db ? -1 : 1;
      }
      return (a.child_order ?? 0) - (b.child_order ?? 0);
    })
    .map((t) => taskView(t.id, t.content, t.description, t));
}

// Title suffix " ×2" wins; otherwise a qty line in the description. One is stored as a bare title.
function taskView(id, content, description, extra) {
  const parsed = splitQuantity(content);
  const fromNote = quantityFromDescription(description);
  const quantity = parsed.quantity > 1 ? parsed.quantity : fromNote;
  const note = visibleNote(description);
  return {
    id,
    content: parsed.name,
    quantity,
    ...(extra && extra.due?.date ? { due: extra.due.date.slice(0, 10) } : {}),
    ...(extra && extra.section_id ? { section: extra.section_id } : {}),
    ...(extra && extra.responsible_uid ? { assignee: String(extra.responsible_uid) } : {}),
    ...(note ? { note } : {}),
  };
}

function shaped(id, content, description) {
  return taskView(id, content, description);
}

// description is Todoist's note under the task (e.g. "For: Chicken Fried Rice", or a product line).
export async function addItem(env, list, content, description) {
  const t = await call(env, '/tasks', {
    method: 'POST',
    body: JSON.stringify({ content, project_id: await projectId(env, list), ...(description ? { description } : {}) }),
  });
  return shaped(t.id, t.content, description);
}

// Replace the title and note of an existing item (a grocery line matched to a product).
export async function updateItem(env, id, content, description) {
  const t = await call(env, '/tasks/' + encodeURIComponent(id), {
    method: 'POST',
    body: JSON.stringify({ content, description: description || '' }),
  });
  return shaped(t.id, t.content, description);
}

// Reads the task so the product note stays, then writes the quantity onto the title and description.
export async function setItemQuantity(env, id, quantity) {
  const n = clampQty(quantity) || 1;
  const current = await call(env, '/tasks/' + encodeURIComponent(id));
  const content = withQuantity(current.content, n);
  const description = setDescriptionQuantity(current.description || '', n);
  await call(env, '/tasks/' + encodeURIComponent(id), {
    method: 'POST',
    body: JSON.stringify({ content, description }),
  });
  return shaped(id, content, description);
}

export async function completeItem(env, id) {
  await call(env, '/tasks/' + encodeURIComponent(id) + '/close', { method: 'POST' });
  return { ok: true };
}
