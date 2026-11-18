import nextConfig from 'eslint-config-next/core-web-vitals';
import nextTypeScriptConfig from 'eslint-config-next/typescript';

const eslintConfig = [
  ...nextConfig,
  ...nextTypeScriptConfig,
  {
    ignores: ['.next/**', '.open-next/**', 'cloudflare-env.d.ts', 'next-env.d.ts'],
  },
];

export default eslintConfig;
