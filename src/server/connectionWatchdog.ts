import * as vscode from "vscode";
import { languageClient, isBuildOperationInProgress } from "../extension";
import Utils, { ServersConfig } from "../utils";
import { connectionPresentation } from "./connectionPresentation";
import {
  ExpectedConnection,
  isConnectionOperationInProgress,
  trySilentReconnectSession
} from "../serversView";

/**
 * Opt-in connection watchdog. NEVER authenticates, disconnects a live session,
 * or mutates the stored token merely because a read-only probe has timed out.
 * It is disabled by default while the protocol is being validated in a real
 * AppServer installation.
 */
const RETRY_DELAYS_MS = [3000, 10000, 30000];
const FAILURE_THRESHOLD = 2;
const HEARTBEAT_TIMEOUT_MS = 12000;

interface WatchedSession extends ExpectedConnection {
  name: string;
}

interface WatchdogSettings {
  enabled: boolean;
  intervalMs: number;
  maxAttempts: number;
}

export class ConnectionWatchdog implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private session?: WatchedSession;
  private epoch = 0;
  private scheduled?: NodeJS.Timeout;
  private retryWait?: { timer: NodeJS.Timeout; resolve: (continueRetry: boolean) => void };
  private busy = false;
  private failures = 0;
  private stopped = false;

  constructor() {
    this.subscriptions.push(ServersConfig.onDidSelectedServer(() => this.refresh()));
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("totvsLanguageServer.connection")) this.refresh(true);
    }));
    this.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => this.refresh(true)));
    this.refresh();
  }

  private options(): WatchdogSettings {
    const config = vscode.workspace.getConfiguration("totvsLanguageServer");
    const seconds = Number(config.get<number>("connection.heartbeatInterval", 60));
    const count = Number(config.get<number>("connection.maxReconnectAttempts", 3));
    return {
      enabled: config.get<boolean>("connection.autoReconnect", false) === true,
      intervalMs: Math.max(30, Math.min(3600, Number.isFinite(seconds) ? seconds : 60)) * 1000,
      maxAttempts: Math.max(1, Math.min(3, Number.isFinite(count) ? Math.floor(count) : 3))
    };
  }

  private snapshot(): WatchedSession | undefined {
    const server = ServersConfig.getCurrentServer();
    if (!server?.id || !server.environment || !server.token) return undefined;
    return {
      id: server.id,
      environment: server.environment,
      token: server.token,
      name: server.name || server.id
    };
  }

  private static same(a?: WatchedSession, b?: WatchedSession): boolean {
    return a?.id === b?.id && a?.environment === b?.environment && a?.token === b?.token;
  }

  private current(session: WatchedSession, epoch: number): boolean {
    return !this.stopped && this.options().enabled && epoch === this.epoch &&
      ConnectionWatchdog.same(session, this.snapshot());
  }

  private log(message: string): void {
    languageClient?.outputChannel?.appendLine("[Connection Watchdog] " + message);
  }

  private clearScheduled(): void {
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = undefined;
  }

  private clearWait(): void {
    if (!this.retryWait) return;
    const wait = this.retryWait;
    this.retryWait = undefined;
    clearTimeout(wait.timer);
    wait.resolve(false);
  }

  private refresh(forceReschedule = false): void {
    if (this.stopped) return;
    const next = this.options().enabled ? this.snapshot() : undefined;
    if (ConnectionWatchdog.same(this.session, next)) {
      if (forceReschedule && !this.busy) this.schedule();
      return;
    }
    this.epoch++;
    this.clearScheduled();
    this.clearWait();
    // An old recovery may no longer own the UI after a switch of session.
    if (this.session && !ConnectionWatchdog.same(this.session, next)) {
      const status = connectionPresentation.forEnvironment(this.session.id, this.session.environment);
      if (status?.phase === "reconnecting" || status?.phase === "verifying") {
        connectionPresentation.clear(this.session.id, this.session.environment);
      }
    }
    this.failures = 0;
    this.session = next;
    if (next && !this.busy) this.schedule();
  }

  private schedule(): void {
    this.clearScheduled();
    if (this.stopped || !this.session || !this.options().enabled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.check();
    }, this.options().intervalMs);
  }

  private shouldPause(): boolean {
    // Do not interfere with user-driven connection flows or the debugger.
    return !languageClient?.isReady || isBuildOperationInProgress() || isConnectionOperationInProgress() ||
      !!vscode.debug.activeDebugSession;
  }

  /** Read-only request with a real VS Code cancellation token. */
  private async probe(session: WatchedSession): Promise<void> {
    const target = ServersConfig.getServerById(session.id);
    if (!target || !languageClient?.isReady) throw new Error("LS_NOT_READY");
    const cancellation = new vscode.CancellationTokenSource();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      const modern = Utils.isServerP20OrGreater(target);
      const method = modern ? "$totvsserver/serverInformations" : "$totvsserver/serverPermissions";
      const field = modern ? "serverInformationsInfo" : "serverPermissionsInfo";
      const params = {} as any;
      params[field] = { connectionToken: session.token };
      const response = await Promise.race([
        languageClient.sendRequest<any>(method, params, cancellation.token),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            cancellation.cancel();
            reject(new Error("PROBE_TIMEOUT"));
          }, HEARTBEAT_TIMEOUT_MS);
        })
      ]);
      if (response?.message !== "OK") {
        throw new Error("PROBE_UNEXPECTED_RESPONSE");
      }
    } catch (error) {
      if (timedOut) throw new Error("PROBE_TIMEOUT");
      // Do not log server errors verbatim; they can contain credentials.
      throw new Error("PROBE_FAILED");
    } finally {
      if (timer) clearTimeout(timer);
      cancellation.dispose();
    }
  }

  private wait(ms: number, session: WatchedSession, epoch: number): Promise<boolean> {
    this.clearWait();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.retryWait?.timer === timer) this.retryWait = undefined;
        resolve(this.current(session, epoch));
      }, ms);
      this.retryWait = { timer, resolve };
    });
  }

  private async recover(session: WatchedSession, epoch: number): Promise<void> {
    const settings = this.options();
    // Keep the remote token in memory while recovering, but never present the
    // session as connected after two confirmed heartbeat failures.
    connectionPresentation.setReconnecting(session.id, session.environment, 0, settings.maxAttempts);
    this.log("Duas verificações consecutivas falharam; iniciando recuperação de " +
      session.name + " / " + session.environment + ".");
    for (let i = 0; i < settings.maxAttempts; i++) {
      if (!this.current(session, epoch) || this.shouldPause()) return;
      if (!await this.wait(RETRY_DELAYS_MS[i], session, epoch)) return;
      if (!this.current(session, epoch) || this.shouldPause()) return;
      connectionPresentation.setReconnecting(session.id, session.environment, i + 1, settings.maxAttempts);
      this.log("Tentativa automática " + (i + 1) + "/" + settings.maxAttempts + ".");
      const outcome = await trySilentReconnectSession(session, () =>
        this.current(session, epoch) && !isBuildOperationInProgress() &&
        !vscode.debug.activeDebugSession);
      if (outcome === "restored" || outcome === "stale") return;
      if (outcome === "rejected") {
        this.log("O servidor rejeitou o token informado. Recuperação encerrada.");
        break;
      }
    }
    if (!this.current(session, epoch) || this.shouldPause()) return;
    // Show a definitive offline icon before invalidating the active session.
    // Only invalidate the original token's session; never clear a newer login.
    connectionPresentation.setDisconnected(session.id, session.environment);
    ServersConfig.markConnectionLost(session.token);
    this.log("Reconexão não realizada. Sessão marcada como desconectada.");
    void vscode.window.showWarningMessage(
      "A sessão de " + session.name + " / " + session.environment +
      " não pôde ser recuperada. Use Connect para uma nova autenticação."
    );
  }

  private async check(): Promise<void> {
    const session = this.session;
    if (!session || this.busy) return;
    const epoch = this.epoch;
    if (!this.current(session, epoch)) {
      this.refresh();
      return;
    }
    if (this.shouldPause()) {
      this.schedule();
      return;
    }
    this.busy = true;
    try {
      await this.probe(session);
      if (this.current(session, epoch)) {
        this.failures = 0;
        // A read-only remote probe confirmed the session is alive again.
        connectionPresentation.clear(session.id, session.environment);
      }
    } catch (error) {
      if (this.current(session, epoch) && !this.shouldPause()) {
        this.failures++;
        if (this.failures === 1) {
          // A single failed probe is not proof of disconnection. Stop showing
          // the green icon and show a distinct verification indicator instead.
          connectionPresentation.setVerifying(session.id, session.environment);
        }
        this.log("Verificação da sessão falhou (" + this.failures + "/" + FAILURE_THRESHOLD + ").");
        if (this.failures >= FAILURE_THRESHOLD) await this.recover(session, epoch);
      }
    } finally {
      this.busy = false;
      if (this.session && !this.scheduled) this.schedule();
    }
  }

  dispose(): void {
    this.stopped = true;
    this.epoch++;
    this.clearScheduled();
    this.clearWait();
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.subscriptions.length = 0;
  }
}
