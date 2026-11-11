// Integration fixtures must never inherit a deployed bot's credentials or state.
// Preserve only the operating-system environment needed to launch local tools.
const operatingSystemKeys = new Set(['PATH','HOME','TMPDIR','TMP','TEMP','LANG','LC_ALL','SYSTEMROOT','SystemRoot','COMSPEC','USERPROFILE','WINDIR','NODE_TEST_CONTEXT','NODE_V8_COVERAGE']);
for (const key of Object.keys(process.env)) if (!operatingSystemKeys.has(key)) delete process.env[key];
