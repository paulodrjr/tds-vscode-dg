import * as vscode from "vscode";
import { ServersConfig } from "../utils";
import { languageClient, isBuildOperationInProgress } from "../extension";
import { probeAppServerSession, CONNECTION_PROBE_TIMEOUT_MS } from "./connectionHealth";
import {
  ExpectedConnection,
  isConnectionOperationInProgress,
  trySilentReconnectSession
} from "../serversView";

const RETRY_DELAYS_MS = [3000, 10000, 30000];
const PROBE_FAILURE_THRESHOLD = 2;

interface HeartbeatSession extends ExpectedConnection {
  name: string;
}

interface HeartbeatSettings {
  enabled: boolean;
  intervalMs: number;
  retries: number;
}

/**
 * Serialized, nonintrusive AppServer monitoring. A heartbeat checks the
 * authenticated session. Recovery is triggered only after two consecutive
 * failed probes, never during compilation, debugging or user-driven connects.
 */
export class ConnectionHeartbeatMonitor implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly debugSessionIds = new Set<string>();
  private timer?: NodeJS.Timeout;
  private retryWait?: { timer: NodeJS.Timeout; resolve: (value: boolean) => void };
  private session?: HeartbeatSession;
  private epoch = 0;
  private failures = 0;
  private checking = false;
  private disposed = false;

  constructor() {
    this.disposables.push(ServersConfig.onDidSelectedServer(() => this.syncSession()));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("totvsLanguageServer.connection")) {
        this.syncSession(true);
      }
    }));
    this.disposables.push(vscode.debug.onDidStartDebugSession(session => {
      this.debugSessionIds.add(session.id);
    }));
    this.disposables.push(vscode.debug.onDidTerminateDebugSession(session => {
      this.debugSessionIds.delete(session.id);
      if (!this.checking && this.session && !this.timer) {
        this.schedule(this.settings().intervalMs);
      }
    }));
    this.syncSession();
  }

  private settings(): HeartbeatSettings {
    const config = vscode.workspace.getConfiguration("totvsLanguageServer");
    const interval = Number(config.get<number>("connection.heartbeatInterval", 60));
    const attempts = Number(config.get<number>("connection.maxReconnectAttempts", 3));
    return {
      enabled: config.get<boolean>("connection.autoReconnect", true) !== false,
      intervalMs: Math.max(30, Math.min(3600, Number.isFinite(interval) ? interval : 60)) * 1000,
      retries: Math.max(1, Math.min(3, Number.isFinite(attempts) ? Math.floor(attempts) : 3))
    };
  }

  private snapshot(): HeartbeatSession | undefined {
    const server = ServersConfig.getCurrentServer();
    if (!server || !server.id || !server.environment || !server.token) return undefined;
    return {
      id: server.id,
      environment: server.environment,
      token: server.token,
      name: server.name || server.id
    };
  }

  private static sameSession(
    left?: HeartbeatSession, right?: HeartbeatSession
  ): boolean {
    return left?.id === right?.id &&
      left?.environment === right?.environment &&
      left?.token === right?.token;
  }

  private log(message: string): void {
    languageClient?.outputChannel?.appendLine("[Heartbeat] " + message);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private cancelRetryWait(): void {
    if (!this.retryWait) return;
    const pending = this.retryWait;
    this.retryWait = undefined;
    clearTimeout(pending.timer);
    pending.resolve(false);
  }

  private syncSession(forceReschedule = false): void {
    if (this.disposed) return;
    const next = this.settings().enabled ? this.snapshot() : undefined;
    if (ConnectionHeartbeatMonitor.sameSession(this.session, next)) {
      if (forceReschedule && !this.checking) {
        this.schedule(this.settings().intervalMs);
      }
      return;
    }

    this.epoch++;
    this.clearTimer();
    this.cancelRetryWait();
    this.session = next;
    this.failures = 0;
    if (next && !this.checking) {
      this.schedule(this.settings().intervalMs);
    }
  }

  private isCurrent(session: HeartbeatSession, epoch: number): boolean {
    if (this.disposed || !this.settings().enabled || epoch !== this.epoch) return false;
    return ConnectionHeartbeatMonitor.sameSession(session, this.snapshot());
  }

  private hasActiveDebug(): boolean {
    return this.debugSessionIds.size > 0 || !!vscode.debug.activeDebugSession;
  }

  private hasCriticalOperation(): boolean {
    return !languageClient?.isReady ||
      isBuildOperationInProgress() || this.hasActiveDebug();
  }

  private shouldPause(): boolean {
    return this.hasCriticalOperation() || isConnectionOperationInProgress();
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (this.disposed || !this.session || !this.settings().enabled) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, delayMs);
  }

  private delayRetry(ms: number, session: HeartbeatSession, epoch: number): Promise<boolean> {
    this.cancelRetryWait();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.retryWait?.timer === timer) this.retryWait = undefined;
        resolve(this.isCurrent(session, epoch));
      }, ms);
      this.retryWait = { timer, resolve };
    });
  }

  private notifyDisconnected(session: HeartbeatSession, reason: string): void {
    this.log("Não foi possível restaurar " + session.name + " / " +
      session.environment + ": " + reason);
    // markConnectionLost checks the token, so it cannot clear another session.
    ServersConfig.markConnectionLost(session.token);
    void vscode.window.showWarningMessage(
      "Conexão com " + session.name + " / " + session.environment +
      " perdida. " + reason + " É necessária uma reconexão manual.",
      "Reconectar manualmente"
    ).then(action => {
      if (action === "Reconectar manualmente") {
        void vscode.commands.executeCommand("totvs-developer-studio.serverSelection");
      }
    });
  }

  private async recover(session: HeartbeatSession, epoch: number): Promise<void> {
    const settings = this.settings();
    this.log("A sessão de " + session.name + " / " + session.environment +
      " não respondeu a duas verificações. Iniciando recuperação silenciosa.");

    let lastError = "AppServer não respondeu.";
    for (let attempt = 0; attempt < settings.retries; attempt++) {
      if (!this.isCurrent(session, epoch) || this.shouldPause()) {
        this.failures = 0;
        return;
      }
      if (!await this.delayRetry(RETRY_DELAYS_MS[attempt], session, epoch)) return;
      if (!this.isCurrent(session, epoch) || this.shouldPause()) {
        this.failures = 0;
        return;
      }

      this.log("Tentativa de reconexão " + (attempt + 1) +
        "/" + settings.retries + " para " + session.name + ".");
      try {
        const result = await trySilentReconnectSession(
          session, CONNECTION_PROBE_TIMEOUT_MS,
          () => this.isCurrent(session, epoch) && !this.hasCriticalOperation()
        );
        if (result === "restored") {
          this.failures = 0;
          this.log("Conexão com " + session.name + " / " +
            session.environment + " restaurada automaticamente.");
          return;
        }
        if (result === "stale" || !this.isCurrent(session, epoch)) return;
        if (result === "invalid-token") {
          this.notifyDisconnected(session,
            "A sessão salva foi rejeitada; autentique-se novamente.");
          return;
        }
      } catch (error) {
        if (!this.isCurrent(session, epoch)) return;
        lastError = error instanceof Error ? error.message : String(error);
        this.log("Falha na tentativa " + (attempt + 1) + ": " + lastError);
      }
    }

    if (this.isCurrent(session, epoch) && !this.shouldPause()) {
      this.notifyDisconnected(session,
        "As " + settings.retries + " tentativas de reconexão falharam. " + lastError);
    }
  }

  private async check(): Promise<void> {
    const session = this.session;
    if (!session || this.checking) return;
    const epoch = this.epoch;
    if (!this.isCurrent(session, epoch)) {
      this.syncSession();
      return;
    }
    if (this.shouldPause()) {
      this.schedule(this.settings().intervalMs);
      return;
    }

    this.checking = true;
    try {
      await probeAppServerSession(
        ServersConfig.getCurrentServer(), CONNECTION_PROBE_TIMEOUT_MS
      );
      if (!this.isCurrent(session, epoch) || this.hasCriticalOperation()) return;
      if (this.failures > 0) {
        this.log("Sessão de " + session.name + " respondeu novamente.");
      }
      this.failures = 0;
    } catch (error) {
      if (!this.isCurrent(session, epoch) || this.shouldPause()) return;
      this.failures++;
      if (this.failures === 1) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log("Primeira verificação sem resposta de " + session.name +
          ": " + detail + ". Será feita uma segunda verificação.");
      }
      if (this.failures >= PROBE_FAILURE_THRESHOLD) {
        await this.recover(session, epoch);
      }
    } finally {
      this.checking = false;
      if (this.session && !this.timer) {
        this.schedule(this.settings().intervalMs);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.clearTimer();
    this.cancelRetryWait();
    this.session = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}
