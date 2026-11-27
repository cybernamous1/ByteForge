// Convert the workspace into a WebContainer FileSystemTree.
export function toFileSystemTree(files, folders = []) {
  const tree = {};
  const dir = parts => {
    let node = tree;
    for (const part of parts) {
      node[part] ??= { directory: {} };
      node = node[part].directory;
    }
    return node;
  };
  for (const f of folders) dir(f.split('/'));
  for (const [path, contents] of files) {
    const parts = path.split('/');
    dir(parts.slice(0, -1))[parts.at(-1)] = { file: { contents } };
  }
  return tree;
}
