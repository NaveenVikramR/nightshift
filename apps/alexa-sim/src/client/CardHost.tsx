'use client';
/**
 * Hosts one Nightshift MCP Apps card (ui://…) like an MCP Apps client does:
 * a sandboxed iframe (scripts only, opaque origin) driven by the official
 * ext-apps AppBridge. Card buttons call tools through /api/tool, which applies
 * the same two-phase rules as the agent.
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { useEffect, useRef } from 'react';
import { api, type CardOut, type ToolResultPayload, type TraceEntry } from './api';

export function CardHost(props: {
  card: CardOut;
  onToolResult: (tool: string, result: ToolResultPayload, trace: TraceEntry[]) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const { card, onToolResult } = props;

  useEffect(() => {
    const frame = ref.current;
    if (!frame?.contentWindow) return;
    let disposed = false;
    const bridge = new AppBridge(
      null,
      { name: 'nightshift-alexa-sim', version: '0.1.0' },
      { serverTools: {} },
    );
    bridge.onsizechange = ({ height }) => {
      if (height && !disposed) frame.style.height = `${Math.min(Math.ceil(height), 2000)}px`;
    };
    bridge.oncalltool = async (params) => {
      const out = await api.tool(params.name, (params.arguments ?? {}) as Record<string, unknown>);
      onToolResult(params.name, out.result, out.trace);
      return out.result as Awaited<ReturnType<NonNullable<typeof bridge.oncalltool>>>;
    };
    bridge.oninitialized = () => {
      bridge.setHostContext({ theme: 'dark', displayMode: 'inline' });
      void bridge.sendToolResult(card.result as Parameters<typeof bridge.sendToolResult>[0]);
    };
    void bridge
      .connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow))
      .then(() => {
        if (!disposed) frame.src = api.cardUrl(card.resourceUri);
      });
    return () => {
      disposed = true;
      void bridge.close().catch(() => undefined);
    };
    // One bridge per card instance (a new card gets a new key).
  }, []);

  return (
    <iframe
      ref={ref}
      className="card-frame"
      title={`Nightshift ${card.tool.replaceAll('_', ' ')} card`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
    />
  );
}
