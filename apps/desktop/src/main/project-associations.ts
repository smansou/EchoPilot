import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { statSync } from 'node:fs';
export type AssociatedProject = { projectId: string; cwd: string; label: string };
/** Explicit folder associations are independent of installed agents and never copy credentials. */
export async function createProjectAssociations(path: string, options: { persist?(state: { projects: AssociatedProject[]; selected: string | null }): Promise<void> } = {}) {
  let projects: AssociatedProject[] = []; let selected: string | null = null;
  try {
    const info = await stat(path); if (info.size > 64_000) throw Error('Project association file is too large.');
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (Array.isArray(value.projects)) projects = value.projects.filter((p: AssociatedProject) => p && typeof p.cwd === 'string' && typeof p.projectId === 'string' && typeof p.label === 'string').slice(0, 32);
    if (typeof value.selected === 'string' && projects.some(p => p.projectId === value.selected)) selected = value.selected;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let mutation: Promise<unknown> = Promise.resolve();
  function serialized<T>(job: () => Promise<T>): Promise<T> { const run = mutation.then(job); mutation = run.then(() => undefined, () => undefined); return run; }
  async function save(nextProjects: AssociatedProject[], nextSelected: string) {
    if (options.persist) await options.persist({ projects: nextProjects, selected: nextSelected });
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ projects: nextProjects, selected: nextSelected }), { mode: 0o600 });
      await rename(temporary, path);
    }
    projects = nextProjects; selected = nextSelected;
  }
  return {
    list: () => projects.map(p => ({ ...p })),
    current: () => { const p = projects.find(p => p.projectId === selected); if (!p) return null; try { return statSync(p.cwd).isDirectory() ? { ...p } : null; } catch { return null; } },
    async associate(folder: string) {
      const cwd = await realpath(folder); if (!(await stat(cwd)).isDirectory()) throw Error('Choose an available project directory.');
      const projectId = createHash('sha256').update(cwd).digest('hex').slice(0, 16); const project = { projectId, cwd, label: basename(cwd) };
      return serialized(async () => {
        const nextProjects = [...projects];
        if (!nextProjects.some(p => p.projectId === projectId)) { if (nextProjects.length >= 32) throw Error('At most 32 project associations may be kept.'); nextProjects.push(project); }
        await save(nextProjects, projectId); return project;
      });
    },
    async select(projectId: string) {
      return serialized(async () => {
        const project = projects.find(p => p.projectId === projectId); if (!project || !(await stat(project.cwd)).isDirectory()) throw Error('That associated project is unavailable.');
        await save([...projects], projectId); return { ...project };
      });
    },
  };
}
