import type { McpServer } from '@modelcontextprotocol/server';
import { acknowledgeAlert } from '../tools/acknowledge_alert.js';
import { addIncidentNote } from '../tools/add_incident_note.js';
import { confirmAction } from '../tools/confirm_action.js';
import { explainIncident } from '../tools/explain_incident.js';
import { getIncidentTimeline } from '../tools/get_incident_timeline.js';
import { getOpsBrief } from '../tools/get_ops_brief.js';
import { getRecentDeploys } from '../tools/get_recent_deploys.js';
import { getSecurityFindings } from '../tools/get_security_findings.js';
import { getServiceHealth } from '../tools/get_service_health.js';
import { listActiveAlerts } from '../tools/list_active_alerts.js';
import { pingNightshift } from '../tools/ping_nightshift.js';
import { prepareAction } from '../tools/prepare_action.js';
import { runSecurityScan } from '../tools/run_security_scan.js';
import { runTool } from '../tools/runTool.js';
import { silenceAlert } from '../tools/silence_alert.js';
import type { ToolDefinition, ToolDeps } from '../tools/types.js';
import { passThroughSchema } from './passThroughSchema.js';

/** Every Nightshift tool. Add new tools here (see the add-mcp-tool skill). */
export const TOOLS: readonly ToolDefinition[] = [
  pingNightshift,
  listActiveAlerts,
  explainIncident,
  getServiceHealth,
  getRecentDeploys,
  acknowledgeAlert,
  silenceAlert,
  prepareAction,
  confirmAction,
  runSecurityScan,
  getSecurityFindings,
  getOpsBrief,
  getIncidentTimeline,
  addIncidentNote,
] as unknown as readonly ToolDefinition[];

export function registerTools(
  server: McpServer,
  deps: ToolDeps,
  tools: readonly ToolDefinition[] = TOOLS,
): void {
  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        // Advertises the real schema; validation happens in runTool (audited).
        inputSchema: passThroughSchema(def.inputSchema),
        annotations: def.annotations,
      },
      (input, ctx) => runTool(def, deps, input, ctx.http?.authInfo, ctx.sessionId),
    );
  }
}
