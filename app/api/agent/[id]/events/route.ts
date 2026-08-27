import {
  isEventIncludedInSnapshot,
  toClientAgentEvent,
} from "@/lib/agent-event-wire";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Fast path: already-running session
  let session = getRpcSession(id);
  if (!session || !session.isAlive()) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
    try {
      ({ session } = await startRpcSession(id, filePath, cwd));
    } catch (error) {
      return new Response(`Failed to start agent: ${error}`, { status: 500 });
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      const snapshotState: { message?: unknown; published: boolean } = {
        published: false,
      };
      const bufferedEvents: Parameters<typeof toClientAgentEvent>[0][] = [];
      const forwardEvent = (event: Parameters<typeof toClientAgentEvent>[0]) => {
        if (isEventIncludedInSnapshot(event, snapshotState.message)) return;
        const clientEvent = toClientAgentEvent(event);
        if (clientEvent) encode(clientEvent);
      };

      // Subscribe before reading the snapshot so no delta can fall into the
      // reconnect gap. Events emitted synchronously while publishing are held
      // until the authoritative snapshot is on the wire.
      const unsubscribe = session.onEvent((event) => {
        if (!snapshotState.published) {
          bufferedEvents.push(event);
          return;
        }
        forwardEvent(event);
      });

      snapshotState.message = session.streamingMessage;
      encode({
        type: "connected",
        sessionId: id,
        isStreaming: session.isStreaming,
      });
      if (snapshotState.message) {
        encode({ type: "message_start", message: snapshotState.message });
      }
      snapshotState.published = true;
      for (const event of bufferedEvents) forwardEvent(event);

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      // Cleanup when client disconnects
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      };

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
