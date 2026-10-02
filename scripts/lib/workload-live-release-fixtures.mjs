import { quiescePipelinesForRef } from "./workload-live-pipeline-quiescence.mjs";

async function ignoreNotFound(operation) {
  try {
    await operation();
  } catch (error) {
    if (error?.result?.status === 404) return;
    throw error;
  }
}

function mutationOutcomeMayBeAmbiguous(error) {
  const status = error?.result?.status ?? error?.status;
  return (
    !Number.isInteger(status) ||
    status === 408 ||
    (status >= 500 && status < 600)
  );
}

async function cleanupOperations(label, operations) {
  const errors = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${label} encountered multiple failures.`);
  }
}

export async function cleanupReleaseFixture(session, fixture) {
  if (!fixture) return;
  const operations = [];
  if (fixture.releaseCreated) {
    operations.push(() =>
      ignoreNotFound(() =>
        session.call("delete_release", {
          project: session.project,
          tag_name: fixture.tagName,
          acknowledge_release_deletion: true,
        }),
      ),
    );
  }
  if (fixture.tagCreated) {
    operations.push(async () => {
      await quiescePipelinesForRef(session, fixture.tagName);
      await ignoreNotFound(() =>
        session.call("delete_tag", {
          project: session.project,
          tag_name: fixture.tagName,
          acknowledge_tag_deletion: true,
          ...(fixture.releaseCreated
            ? { acknowledge_associated_release_deletion: true }
            : {}),
        }),
      );
    });
  }
  await cleanupOperations("Release fixture cleanup", operations);
}

export async function createReleaseFixture(
  session,
  tagName,
  { assetName, assetUrl, assetLinkType = "other", description } = {},
) {
  const fixture = {
    tagName,
    tagCreated: false,
    releaseCreated: false,
  };
  try {
    try {
      await session.call("create_tag", {
        project: session.project,
        tag_name: tagName,
        ref: session.defaultBranch,
      });
      fixture.tagCreated = true;
    } catch (error) {
      // A timeout, transport failure, or 5xx can occur after GitLab accepts the
      // mutation. Claim cleanup ownership only for those ambiguous outcomes;
      // definitive 4xx rejection must not authorize deletion of pre-existing state.
      if (mutationOutcomeMayBeAmbiguous(error)) fixture.tagCreated = true;
      throw error;
    }

    try {
      fixture.release = await session.call("create_release", {
        project: session.project,
        tag_name: tagName,
        name: `BENCH ${tagName}`,
        description: description || "Disposable benchmark release fixture.",
        ref: session.defaultBranch,
      });
      fixture.releaseCreated = true;
    } catch (error) {
      if (mutationOutcomeMayBeAmbiguous(error)) fixture.releaseCreated = true;
      throw error;
    }

    if (assetName) {
      fixture.assetLink = await session.call("create_release_asset_link", {
        project: session.project,
        tag_name: tagName,
        name: assetName,
        url: assetUrl,
        link_type: assetLinkType,
      });
    }
    return fixture;
  } catch (error) {
    try {
      await cleanupReleaseFixture(session, fixture);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Release fixture setup failed and cleanup could not be completed.",
      );
    }
    throw error;
  }
}
