import * as vscode from "vscode";

/**
 * UI-only state. Never changes saved tokens or the selected AppServer.
 * While reconnecting, the original token is retained exclusively for recovery.
 */
export type ConnectionVisualPhase = "verifying" | "reconnecting" | "disconnected";

export interface ConnectionVisualState {
  readonly id: string;
  readonly environment: string;
  readonly phase: ConnectionVisualPhase;
  readonly attempt: number;
  readonly maxAttempts: number;
}

class ConnectionPresentation implements vscode.Disposable {
  private state?: ConnectionVisualState;
  private readonly changes = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changes.event;

  public active(): ConnectionVisualState | undefined { return this.state; }

  public forServer(id: string): ConnectionVisualState | undefined {
    return this.state?.id === id ? this.state : undefined;
  }

  public forEnvironment(id: string, environment: string): ConnectionVisualState | undefined {
    return this.state?.id === id && this.state.environment === environment
      ? this.state : undefined;
  }

  public setVerifying(id: string, environment: string): void {
    this.update({id, environment, phase: "verifying", attempt: 0, maxAttempts: 0});
  }

  public setReconnecting(id: string, environment: string, attempt = 0, maxAttempts = 3): void {
    this.update({
      id, environment, phase: "reconnecting",
      attempt: Math.max(0, attempt), maxAttempts: Math.max(1, maxAttempts)
    });
  }

  public setDisconnected(id: string, environment: string): void {
    this.update({ id, environment, phase: "disconnected", attempt: 0, maxAttempts: 0 });
  }

  public clear(id?: string, environment?: string): void {
    if (!this.state || (id && this.state.id !== id) ||
        (environment && this.state.environment !== environment)) return;
    this.state = undefined;
    this.changes.fire();
  }

  private update(next: ConnectionVisualState): void {
    const previous = this.state;
    if (previous && previous.id === next.id && previous.environment === next.environment &&
        previous.phase === next.phase && previous.attempt === next.attempt &&
        previous.maxAttempts === next.maxAttempts) return;
    this.state = next;
    this.changes.fire();
  }

  public dispose(): void { this.changes.dispose(); }
}

export const connectionPresentation = new ConnectionPresentation();
