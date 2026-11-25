import { stubCommand } from './stub';

export const buildCommand = stubCommand({
  name: 'build',
  description: '从界面文档生成资源（切图、九宫格、字体等）',
});
