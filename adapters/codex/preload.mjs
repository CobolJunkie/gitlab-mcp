import pluginMetadata from "../../.codex-plugin/plugin.json" with { type: "json" };
import { setDistributionMetadata } from "../../shared/distribution-metadata.mjs";

setDistributionMetadata({
  name: pluginMetadata.name,
  version: pluginMetadata.version,
});
