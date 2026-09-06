export function matchWorkspace(cwd, items) {
  if (!cwd || !Array.isArray(items)) return null;
  for (const ws of items) {
    const wsPath = (ws && ws.path) || '';
    if (!wsPath) continue;
    if (cwd === wsPath || cwd.startsWith(wsPath + '/') || cwd.startsWith(wsPath + '\\')) {
      return { path: wsPath, key: (ws && (ws.workspaceId || ws.id)) || wsPath };
    }
  }
  return null;
}
