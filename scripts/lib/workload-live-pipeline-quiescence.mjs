import { isTerminalPipelineStatus } from "./workload-live-pipeline-status.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const PIPELINE_STOP_ATTEMPTS = 60;
const PIPELINE_STOP_POLL_MS = 250;

function rows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.data) ? result.data : [];
}

function isNotFound(error) {
  return error?.result?.status === 404 || error?.status === 404;
}

async function listRefPipelines(session, ref) {
  const entries = [];
  let page = 1;
  for (let attempt = 0; attempt < MAX_PAGES; attempt += 1) {
    const result = await session.call("list_pipelines", {
      project: session.project,
      ref,
      page,
      per_page: PAGE_SIZE,
    });
    const batch = rows(result);
    entries.push(...batch);

    const pagination = result?.pagination;
    const nextPage = Number(pagination?.nextPage);
    if (Number.isSafeInteger(nextPage) && nextPage > page) {
      page = nextPage;
      continue;
    }
    if (
      Number.isSafeInteger(pagination?.page) &&
      Number.isSafeInteger(pagination?.totalPages) &&
      pagination.page < pagination.totalPages
    ) {
      page = pagination.page + 1;
      continue;
    }
    if (!pagination && batch.length === PAGE_SIZE) {
      page += 1;
      continue;
    }
    return entries;
  }
  throw new Error(
    `Benchmark pipeline cleanup exceeded ${MAX_PAGES} pages for ref ${ref}.`,
  );
}

async function waitForPipelineStopped(session, pipelineId) {
  for (let attempt = 0; attempt < PIPELINE_STOP_ATTEMPTS; attempt += 1) {
    let current;
    try {
      current = await session.call("get_pipeline", {
        project: session.project,
        pipeline_id: pipelineId,
      });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (isTerminalPipelineStatus(current?.status)) return;
    if (attempt + 1 < PIPELINE_STOP_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, PIPELINE_STOP_POLL_MS),
      );
    }
  }
  throw new Error(
    `Benchmark fixture pipeline ${pipelineId} did not stop before cleanup timeout.`,
  );
}

export async function quiescePipelinesForRef(session, ref) {
  const pipelines = await listRefPipelines(session, ref);
  for (const pipeline of pipelines) {
    if (isTerminalPipelineStatus(pipeline?.status)) continue;
    if (!Number.isSafeInteger(pipeline?.id)) {
      throw new TypeError(
        `Refusing to delete benchmark ref ${ref}: a nonterminal pipeline could not be identified by a valid numeric ID.`,
      );
    }
    try {
      await session.call("cancel_pipeline", {
        project: session.project,
        pipeline_id: pipeline.id,
      });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    await waitForPipelineStopped(session, pipeline.id);
  }
}
