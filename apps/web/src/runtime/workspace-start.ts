export interface WorkspaceStartTasks<Runtime, Revision, Content> {
  readonly runtime: Promise<Runtime>;
  readonly revision: Promise<Revision>;
  readonly content: Promise<Content>;
}

/**
 * Joins the independently loaded workspace prerequisites. If one sibling
 * fails, all signal-aware fetch work is aborted and observed before the
 * failure is returned to React. Dynamic imports are not abortable, but they
 * remain cache-only and do not retain a request or Runtime controller.
 */
export async function awaitWorkspaceStart<Runtime, Revision, Content>(
  controller: AbortController,
  tasks: WorkspaceStartTasks<Runtime, Revision, Content>
): Promise<[Runtime, Revision, Content]> {
  try {
    return await Promise.all([tasks.runtime, tasks.revision, tasks.content]);
  } catch (error) {
    controller.abort();
    await Promise.allSettled([tasks.revision, tasks.content]);
    throw error;
  }
}
