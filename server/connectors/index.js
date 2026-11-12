import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("../config/field-mappings.json", import.meta.url));
const mappingConfig = JSON.parse(readFileSync(configPath, "utf8"));

export const connectorStatus = [
  {
    id: "pos_unconfigured",
    type: "pos",
    configured: mappingConfig.pos.configured,
    implemented: false,
    requiredFields: mappingConfig.pos.unavailable_until_source_mapping_is_supplied,
    schedule: "Every 5 minutes after an authorized source is configured",
  },
  {
    id: "billing_unconfigured",
    type: "tenant_billing",
    configured: mappingConfig.tenant_billing.configured,
    implemented: false,
    requiredFields: mappingConfig.tenant_billing.unavailable_until_source_mapping_is_supplied,
    schedule: "Every 15 minutes or source event after an authorized source is configured",
  },
];

export function getConnector(sourceType) {
  const source = connectorStatus.find((item) => item.type === sourceType);
  if (!source) throw new Error(`Unknown connector type: ${sourceType}`);
  if (!source.configured) {
    const error = new Error(`${sourceType} connector is not configured; no source connection was attempted.`);
    error.code = "CONNECTOR_NOT_CONFIGURED";
    throw error;
  }
  const error = new Error(`The ${sourceType} connector has no source-specific implementation.`);
  error.code = "CONNECTOR_NOT_IMPLEMENTED";
  throw error;
}
