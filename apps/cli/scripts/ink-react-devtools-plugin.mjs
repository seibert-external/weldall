export const reactDevtoolsNoopModule = `
const reactDevtools = Object.freeze({
  initialize() {},
  connectToDevTools() {},
});
export { reactDevtools as default };
`;

/**
 * Ink 7.1.1 resolves its optional react-devtools-core peer while Bun compiles
 * the production graph. A virtual no-op keeps that single optional peer out of
 * the executable without patching Ink or node_modules.
 */
export function inkReactDevtoolsPlugin() {
  return {
    name: "weldall-ink-react-devtools-noop",
    setup(build) {
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
        path: "react-devtools-core",
        namespace: "weldall-ink-noop",
      }));
      build.onLoad({ filter: /^react-devtools-core$/, namespace: "weldall-ink-noop" }, () => ({
        contents: reactDevtoolsNoopModule,
        loader: "js",
      }));
    },
  };
}
