import type { SetupFunction } from '@vercel/agent-eval';

export function withGeminiWorkspaceTrust(setup: SetupFunction): SetupFunction {
  return async (sandbox) => {
    await setup(sandbox);

    const trustSetupResult = await sandbox.runCommand('bash', [
      '-c',
      `mkdir -p ~/.gemini; printf '{"%s":"TRUST_FOLDER","/workspace":"TRUST_FOLDER"}\\n' "$1" > ~/.gemini/trustedFolders.json; chmod 600 ~/.gemini/trustedFolders.json`,
      'bash',
      sandbox.getWorkingDirectory(),
    ]);
    if (trustSetupResult.exitCode !== 0) {
      throw new Error(`Failed to configure Gemini workspace trust: ${trustSetupResult.stderr}`);
    }
  };
}
