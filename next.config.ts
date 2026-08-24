import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'
import path from 'path'
import { fileURLToPath } from 'url'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const buildMode = process.env.NEX_BUILD_MODE || 'production';
let distDir = '.next';
let tsconfigPath = 'tsconfig.json';

if (buildMode === 'verify') {
  distDir = '.next-verify';
  tsconfigPath = 'tsconfig.verify.json';
} else if (buildMode === 'e2e') {
  distDir = '.next-e2e-auth';
  tsconfigPath = 'tsconfig.e2e.json';
} else {
  distDir = '.next';
  tsconfigPath = 'tsconfig.json';
}

const nextConfig: NextConfig = {
  distDir,
  typescript: {
    tsconfigPath,
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }

    return config
  },
  turbopack: {
    root: path.resolve(dirname),
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
