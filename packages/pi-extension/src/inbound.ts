import type { Message } from "@pi-comm/a2a-contract";

export interface InboundJob {
  reqId: string;
  stream: boolean;
  contextId?: string;
  done: boolean;
}

export function extractPromptText(message: Message): string {
  return message.parts
    .filter((p): p is { text: string } => typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n");
}

export class InboundManager {
  private jobs: InboundJob[] = [];

  begin(reqId: string, message: Message, stream: boolean): { promptText: string; job: InboundJob } {
    const job: InboundJob = { reqId, stream, contextId: message.contextId, done: false };
    this.jobs.push(job);
    return { promptText: extractPromptText(message), job };
  }

  oldestOpen(): InboundJob | undefined {
    return this.jobs.find((j) => !j.done);
  }

  complete(reqId: string): void {
    const j = this.jobs.find((x) => x.reqId === reqId);
    if (j) j.done = true;
    this.jobs = this.jobs.filter((x) => !x.done || x.reqId === reqId).slice(-50);
  }
}
