export function renderClaudeEnv(endpoint: string, key: string, servedModel: string): string {
  return [
    `export ANTHROPIC_BASE_URL="${endpoint}"`,
    `export ANTHROPIC_AUTH_TOKEN="${key}"`,
    `export ANTHROPIC_MODEL="${servedModel}"`,
    '',
  ].join('\n');
}
