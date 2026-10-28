import { DebugAdapterDescriptorFactory, DebugSession, DebugAdapterExecutable, ProviderResult, DebugAdapterDescriptor, ExtensionContext } from 'vscode';
import { getDAP } from './debugConfigs';
import * as fs from 'fs';

export class TotvsDebugAdapterDescriptorFactory implements DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: DebugSession, executable: DebugAdapterExecutable | undefined): ProviderResult<DebugAdapterDescriptor> {
		// use the executable specified in the package.json if it exists or determine it based on some other information (e.g. the session)
		if (!executable) {
			let dap = getDAP();
			if (!dap.command || !fs.existsSync(dap.command)) {
				throw new Error("TOTVS Debug Adapter executable missing. Reinstall the extension or check @totvs/tds-da.");
			}
			executable = new DebugAdapterExecutable(dap.command, dap.args);
		}
		// make VS Code launch the DA executable
		return executable;
	}

}