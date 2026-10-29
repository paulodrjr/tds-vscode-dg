import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import {
  checkConnectionToken,
  describeMissingConnectionToken
} from "./server/connectionTokenGuard";

export class TotvsLanguageClientA extends LanguageClient {
  private _ready: boolean = false;

  public get isReady(): boolean {
    return this._ready;
  }

  public set ready(value: boolean) {
    this._ready = value;
  }

  constructor(
    serverOptions: ServerOptions,
    clientOptions: LanguageClientOptions
  ) {
    super(
      "totvsLanguageServer",
      "TOTVS Language Server",
      serverOptions,
      clientOptions
    );

    // The LS accepts many different TOTVS RPC methods. Some older extension
    // callers bypass protocolMessages.ts and send directly through the client.
    // Guard the final common boundary so no session operation can reach the LS
    // with an empty token (and identify the offending operation in TOTVS LS).
    const forward = this.sendRequest.bind(this);
    this.sendRequest = ((type: any, ...args: any[]) => {
      const method: string = typeof type === "string" ? type : type?.method;
      const check = checkConnectionToken(method, args[0]);
      if (!check.valid) {
        const diagnostic = describeMissingConnectionToken(check.operation);
        const caller = new Error().stack?.split("\n").slice(2, 5)
          .map(frame => frame.trim()).join(" | ") || "unknown";
        const summary = "[Connection Token Guard] " + diagnostic;
        // Do not log the token, request payload, username or password.
        this.outputChannel?.appendLine(summary);
        this.outputChannel?.appendLine("[Connection Token Guard] Origem: " + caller);
        return Promise.reject(new Error(diagnostic));
      }
      return (forward as any)(type, ...args);
    }) as typeof this.sendRequest;
  }

  registerBuiltinFeatures() {
    super.registerBuiltinFeatures();
  }
}
