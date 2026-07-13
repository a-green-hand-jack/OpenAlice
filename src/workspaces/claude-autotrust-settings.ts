const PRETRUSTED_BASH_TOOLS = ['alice', 'alice-analysis', 'alice-uta', 'alice-workspace', 'traderhub'];
const PRETRUSTED_FILE_TOOLS = ['Write', 'Edit'];

/** Shared, SDK-free settings payload used by both Claude control faces. */
export const AUTOTRUST_SETTINGS_OBJECT = {
  enableAllProjectMcpServers: true,
  permissions: {
    allow: [
      ...PRETRUSTED_BASH_TOOLS.map((bin) => `Bash(${bin} *)`),
      ...PRETRUSTED_FILE_TOOLS,
    ],
  },
};
