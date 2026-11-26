import { stubCommand } from './stub';

export const buildCommand = stubCommand({
  name: 'build',
  description: '按决定构建界面的资产（抠取、补全、文字剥离、九宫、提升分辨率）',
});
