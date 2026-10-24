import path from 'path';

// Minimal structural Babel types so the config does not need @babel/core as a direct dependency.
type BabelNode = {
  type: string;
  name?: string;
  id?: BabelNode | null;
  loc?: { start: { line: number; column: number } } | null;
  attributes: BabelNode[];
};
type NodePath = { node: BabelNode; parent: BabelNode; parentPath: NodePath | null };
type NodeGuard = (node: unknown, opts?: Record<string, unknown>) => node is BabelNode;
type BabelTypes = {
  isFunctionDeclaration: NodeGuard;
  isClassDeclaration: NodeGuard;
  isArrowFunctionExpression: NodeGuard;
  isFunctionExpression: NodeGuard;
  isVariableDeclarator: NodeGuard;
  isIdentifier: NodeGuard;
  isJSXIdentifier: NodeGuard;
  isJSXAttribute: NodeGuard;
  jsxAttribute: (name: BabelNode, value: BabelNode) => BabelNode;
  jsxIdentifier: (name: string) => BabelNode;
  stringLiteral: (value: string) => BabelNode;
};
type PluginObj = {
  name: string;
  visitor: { JSXOpeningElement: (p: NodePath, state: { filename?: string }) => void };
};

/**
 * Dev-only Babel plugin: annotates JSX host elements (lowercase tags) with
 * `data-vx-source="relative/path:line:col"` and `data-vx-component="Name"`
 * so in-app UI debugging tools can map DOM nodes back to source.
 * Only registered when Vite runs in `serve` mode; production builds never see it.
 */
export function vxSourceAnnotation(rootDir: string) {
  return function vxSourceAnnotationPlugin({
    types: t,
  }: {
    types: BabelTypes;
  }): PluginObj {
    const componentName = (p: NodePath): string | null => {
      let current: NodePath | null = p.parentPath;
      while (current) {
        const node = current.node;
        let name: string | null = null;
        if (t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) {
          name = node.id?.name ?? null;
        } else if (
          (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) &&
          t.isVariableDeclarator(current.parent) &&
          current.parent.id &&
          t.isIdentifier(current.parent.id)
        ) {
          name = current.parent.id.name ?? null;
        }
        if (name && /^[A-Z]/.test(name)) return name;
        current = current.parentPath;
      }
      return null;
    };

    return {
      name: 'vx-source-annotation',
      visitor: {
        JSXOpeningElement(p, state) {
          const nameNode = p.node.name;
          if (!t.isJSXIdentifier(nameNode) || !/^[a-z]/.test(nameNode.name ?? '')) return;
          const filename = state.filename;
          const loc = p.node.loc;
          if (!filename || !loc || filename.includes('node_modules')) return;
          const has = (attr: string) =>
            p.node.attributes.some(
              (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: attr }),
            );
          if (has('data-vx-source')) return;
          const rel = path.relative(rootDir, filename).split(path.sep).join('/');
          const attrs = [
            t.jsxAttribute(
              t.jsxIdentifier('data-vx-source'),
              t.stringLiteral(`${rel}:${loc.start.line}:${loc.start.column + 1}`),
            ),
          ];
          const component = componentName(p);
          if (component && !has('data-vx-component')) {
            attrs.push(
              t.jsxAttribute(t.jsxIdentifier('data-vx-component'), t.stringLiteral(component)),
            );
          }
          p.node.attributes.push(...attrs);
        },
      },
    };
  };
}
