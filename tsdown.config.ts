import type { UserConfig } from 'tsdown'

/**
 * Node half + browser half。node 半所有 @deepseek-ai 包与 schemastery 保持
 * external：运行时由 profile 的 node_modules 解析，且 Loader 校验 Config
 * schema 时必须看到它自己的 schemastery 实例。browser 半产出 lib/client.js，
 * 由 harness 以 /plugins/<id>/client.js 提供，ModuleLoader 包裹；平台模块表
 * 共享的模块（React / Cordis / client-runtime）保持 external。
 */
export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-agent',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-host-apiproxy',
        '@deepseek-ai/dsh-attachment',
      ],
    },
  },
  {
    // Browser half: lib/client.js, wrapped for window.__ModuleLoader__ (see
    // dsh-visualize 的客户端构建).
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    deps: {
      neverBundle: [
        'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-runtime/client',
      ],
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-cross-chat')}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
