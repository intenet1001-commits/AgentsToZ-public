export interface OperationDiagnosticInput {
  operation: string;
  projectName?: string;
  projectPath?: string;
  message: string;
  backendDiagnostic?: string;
  timestamp?: string;
}

export function formatOperationDiagnostic(input: OperationDiagnosticInput): string {
  const lines = [
    '[AgentsToZ 오류 보고]',
    `시간: ${input.timestamp ?? new Date().toISOString()}`,
    `작업: ${input.operation}`,
  ];
  if (input.projectName) lines.push(`프로젝트: ${input.projectName}`);
  if (input.projectPath) lines.push(`경로: ${input.projectPath}`);
  lines.push(`오류: ${input.message}`);
  if (input.backendDiagnostic?.trim()) lines.push('', input.backendDiagnostic.trim());
  return lines.join('\n').slice(0, 40 * 1024);
}
